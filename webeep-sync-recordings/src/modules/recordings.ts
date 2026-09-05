import got from "got"
import { recordingBrowser } from "./browser-recorder"
import { moodleClient } from "./moodle"
import { createLogger } from "./logger"
import { WebExRecording, WebExStreamInfo } from "./recordings-types"
import { store } from "./store"
import {
  extractVideoID,
  isWebExUrl,
  isArchiveUrl,
  isRecordingCandidate,
  normalizeRecordingUrl,
  extractCandidateUrlsFromHtml,
  resolvedRecordingUrl,
  parseLectureDate,
} from "./recording-links"

/* eslint-disable no-useless-escape, @typescript-eslint/no-explicit-any */

const { log, debug, error } = createLogger("Recordings")

export async function resolveWebExRecordingUrl(url: string): Promise<string> {
  if (!isWebExUrl(url)) throw new Error("Expected a WebEx recording link.")
  if (extractVideoID(url) && !/ldr\.php/i.test(url))
    return normalizeRecordingUrl(url)!
  const resolved = await recordingBrowser.navigateInTemporaryWindow(url)
  const recording = resolvedRecordingUrl(
    [...resolved.urls, resolved.finalUrl],
    resolved.html,
    resolved.finalUrl,
  )
  if (!recording)
    throw new Error(
      "No recording was found after opening the WebEx link. Check your session and access permissions.",
    )
  return recording
}

/**
 * Discovery drives the hidden browser through WeBeep pages, so it needs live
 * SSO cookies in the default session — the Moodle API token alone is not
 * enough. Returns true when WeBeep bounces the hidden browser to the login
 * screen, meaning an interactive login is required first.
 */
export async function browserSessionNeedsLogin(): Promise<boolean> {
  await recordingBrowser.navigateAndWait(
    "https://webeep.polimi.it/my/",
    "body",
    15000,
  )
  const currentUrl = await recordingBrowser.executeScript(
    "return window.location.href",
  )
  const normalized = String(currentUrl || "").toLowerCase()
  const needsLogin =
    normalized.includes("aunicalogin.polimi.it") ||
    normalized.includes("shibidp.polimi.it") ||
    normalized.includes("/auth/shibboleth") ||
    normalized.includes("idserver.servizicie.interno.gov.it") ||
    // An unauthenticated /my/ lands on Moodle's own login page first.
    normalized.includes("webeep.polimi.it/login")
  log(
    `Browser session login check: url=${currentUrl}, needsLogin=${needsLogin}`,
  )
  return needsLogin
}

export async function getAunicaUrlFromWebeep(
  courseId: number,
): Promise<string | null> {
  const courseUrl = `https://webeep.polimi.it/course/view.php?id=${courseId}`
  await recordingBrowser.navigateAndWait(courseUrl)
  const page = await recordingBrowser.executeScript(`
    return {
      login: !!document.querySelector('input[type="password"]'),
      links: Array.from(document.querySelectorAll('a, button, [role="button"]')).map(el => ({
        text: (el.textContent || '').trim(),
        href: el.getAttribute('href') || el.getAttribute('data-href') || '',
        onclick: el.getAttribute('onclick') || '',
      })),
      url: location.href,
    };
  `)
  if (page.login)
    throw new Error("WeBeep sign-in is required to read this course.")
  for (const link of page.links) {
    const values = [
      link.href,
      ...Array.from(
        String(link.onclick).matchAll(/["']([^"']+)["']/g),
        match => match[1],
      ),
    ]
    for (const value of values) {
      const url = normalizeRecordingUrl(value, page.url)
      if (
        url &&
        (isArchiveUrl(url) ||
          (/archivio registrazioni|recordings archive/i.test(link.text) &&
            new URL(url).hostname === "webeep.polimi.it"))
      )
        return url
    }
  }
  return null
}

interface RecManRecordingCandidate {
  webexUrl: string
  title?: string
  dateText?: string
}

interface RecManIncrementalOptions {
  knownCandidateUrls?: ReadonlySet<string>
  onCandidateResolved?: (candidateUrl: string) => void
  onCandidateFailed?: (candidateUrl: string, message: string) => void
}

function isMeaningfulRecordingTitle(title?: string): title is string {
  if (!title) return false
  const normalized = title.trim()
  const isDate =
    /^\d{1,2}[/:.-]\d{1,2}(?:[/:.-]\d{2,4})?(?:\s+\d{1,2}:\d{2})?$/.test(
      normalized,
    )
  return Boolean(
    normalized &&
    !/^Recording [a-f0-9]{32}$/i.test(normalized) &&
    !/^\d+\s*(?:min|mins|minutes|minuti)$/i.test(normalized) &&
    !/^\d+(?:[.,]\d+)?\s*(?:kb|mb|gb)$/i.test(normalized) &&
    !isDate,
  )
}

export async function extractWebExUrlsFromRecMan(
  recmanUrl: string,
  incremental: RecManIncrementalOptions = {},
): Promise<RecManRecordingCandidate[]> {
  const combined = new Map<
    string,
    { href: string; title?: string; dateText?: string }
  >()
  const pendingPages = [recmanUrl]
  const visitedPages = new Set<string>()
  let expanded = false
  while (pendingPages.length) {
    const pageUrl = pendingPages.shift()!
    if (visitedPages.has(pageUrl)) continue
    if (visitedPages.size >= 50)
      throw new Error("Archive exceeds 50 pages; discovery is incomplete.")
    visitedPages.add(pageUrl)
    await recordingBrowser.navigateAndWait(pageUrl)
    const page = await recordingBrowser.executeScript(`
      const docs = [document];
      for (const frame of Array.from(document.querySelectorAll('iframe, frame'))) {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) { /* cross-origin frame */ }
      }
      const links = docs.flatMap(doc => Array.from(doc.querySelectorAll('a[href], area[href], [data-href]')));
      const rows = links.map(element => {
        const row = element.closest('tr');
        const table = element.closest('table');
        const headers = table ? Array.from(table.querySelectorAll('th')).map(cell => (cell.textContent || '').toLowerCase()) : [];
        const topicIndex = headers.findIndex(text => /argomento|topic|titolo/.test(text));
        const cells = row ? Array.from(row.querySelectorAll('td')).map(cell => (cell.textContent || '').replace(/\\s+/g, ' ').trim()) : [];
        const dateText = cells.find(text => /\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}/.test(text));
        const validTitle = text => text && !/^(video|webex|link|apri|open|vedi|visualizza|download|registrazione)$/i.test(text) &&
          !/^\\d+\\s*(?:min|mins|minutes|minuti|kb|mb|gb)$/i.test(text) && !/^\\d{1,2}[/.\\-]\\d{1,2}/.test(text);
        const topic = topicIndex >= 0 ? cells[topicIndex] : '';
        const title = validTitle(topic) ? topic : cells.filter(validTitle).sort((a,b) => b.length-a.length)[0];
        return { href: element.href || element.getAttribute('data-href'), title, dateText };
      });
      const pageLinks = links.filter(link => link.rel === 'next' || /^(successiv[ao]|next|[›»])$/i.test((link.textContent || '').trim()) || /[?&]action=(?:plen_(?:all|\\d+)|pnext|next)(?:&|$)/i.test(link.href || '')).map(link => link.href);
      const frames = Array.from(document.querySelectorAll('iframe[src], frame[src]')).map(frame => frame.src);
      return {
        rows, pageLinks, frames, url: location.href,
        html: docs.map(doc => doc.documentElement.outerHTML).join('\\n'),
        login: docs.some(doc => !!doc.querySelector('input[type="password"]')),
        archive: docs.some(doc => !!doc.querySelector('table, #form_tabella_transfers')),
      };
    `)
    if (page.login)
      throw new Error(
        "Archive sign-in is required. Sign in again and retry discovery.",
      )
    const candidates = [
      ...page.rows,
      ...extractCandidateUrlsFromHtml(page.html, page.url).map(href => ({
        href,
      })),
    ]
    for (const candidate of candidates) {
      const href = normalizeRecordingUrl(candidate.href || "", page.url)
      if (!href || !isRecordingCandidate(href)) continue
      const previous = combined.get(href)
      combined.set(href, {
        ...candidate,
        ...previous,
        href,
        title: previous?.title || candidate.title,
        dateText: previous?.dateText || candidate.dateText,
      })
    }
    const pageLinks = (page.pageLinks as string[])
      .map(url => normalizeRecordingUrl(url, page.url))
      .filter(
        (url): url is string =>
          !!url && new URL(url).origin === new URL(page.url).origin,
      )
    const expansions = pageLinks
      .filter(url => /[?&]action=plen_/i.test(url))
      .sort((a, b) => {
        const score = (url: string) =>
          /plen_all/i.test(url)
            ? Infinity
            : Number(url.match(/plen_(\d+)/i)?.[1] || 0)
        return score(b) - score(a)
      })
    if (!expanded && expansions.length) {
      expanded = true
      pendingPages.push(expansions[0])
    } else {
      pendingPages.push(
        ...pageLinks.filter(url => !/[?&]action=plen_/i.test(url)),
      )
    }
    const frames = (page.frames as string[]).filter(isArchiveUrl)
    pendingPages.push(...frames)
    if (!page.archive && !combined.size && !frames.length)
      throw new Error(
        "The archive did not expose a recordings table or recording links. Discovery is incomplete.",
      )
  }

  // Known rows can be interleaved with new uploads or sorted oldest-first.
  // Inspect every page, but only open links that have not resolved successfully.
  const pending = Array.from(combined.values()).filter(
    candidate => !incremental.knownCandidateUrls?.has(candidate.href),
  )
  const resolvedByUrl = new Map<string, RecManRecordingCandidate>()
  const workers = Array.from(
    { length: Math.min(2, pending.length) },
    async () => {
      while (pending.length) {
        const candidate = pending.shift()!
        try {
          let webexUrl: string
          if (isWebExUrl(candidate.href)) {
            webexUrl = await resolveWebExRecordingUrl(candidate.href)
          } else {
            const result = await recordingBrowser.navigateInTemporaryWindow(
              candidate.href,
            )
            const resolved = resolvedRecordingUrl(
              [...result.urls, result.finalUrl],
              result.html,
              result.finalUrl,
            )
            if (!resolved)
              throw new Error(
                "Link did not resolve to an accessible WebEx recording.",
              )
            webexUrl = resolved
          }
          resolvedByUrl.set(candidate.href, {
            webexUrl,
            title: candidate.title,
            dateText: candidate.dateText,
          })
          incremental.onCandidateResolved?.(candidate.href)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!incremental.onCandidateFailed) throw err
          incremental.onCandidateFailed(candidate.href, message)
        }
      }
    },
  )
  await Promise.all(workers)
  const unique = new Map<string, RecManRecordingCandidate>()
  for (const url of Array.from(combined.keys())) {
    const candidate = resolvedByUrl.get(url)
    if (!candidate) continue
    const id = extractVideoID(candidate.webexUrl)!
    const previous = unique.get(id)
    if (!previous || (!previous.title && candidate.title))
      unique.set(id, candidate)
  }
  log(
    `Resolved ${unique.size} recordings from ${combined.size} links across ${visitedPages.size} archive pages`,
  )
  return Array.from(unique.values())
}

export async function extractLectureMetadataFromArchive(
  archiveUrl: string,
  courseId: number,
  courseName?: string,
): Promise<WebExRecording[]> {
  debug(`extractLectureMetadataFromArchive start for ${archiveUrl}`)
  try {
    await recordingBrowser.navigateAndWait(
      archiveUrl,
      ".TableDati, .TableDati-tbody, #form_tabella_transfers",
      30000,
    )
    await new Promise(r => setTimeout(r, 1500))

    const recManState = await recordingBrowser.executeScript(`
      new Promise(resolve => {
        const selector = '.TableDati-tbody, .TableDati, table.TableDati';
        const getState = () => ({
          url: window.location.href,
          title: document.title,
          readyState: document.readyState,
          tableCount: document.querySelectorAll(selector).length,
          iframeCount: document.querySelectorAll('iframe, frame').length,
          anchorCount: document.querySelectorAll('a').length,
          bodyTextSnippet: document.body.textContent?.slice(0, 300) || ''
        });

        const state = getState();
        if (state.tableCount > 0) return resolve(state);

        let elapsed = 0;
        const interval = setInterval(() => {
          const nextState = getState();
          if (nextState.tableCount > 0) {
            clearInterval(interval);
            return resolve(nextState);
          }
          elapsed += 200;
          if (elapsed >= 15000) {
            clearInterval(interval);
            return resolve(nextState);
          }
        }, 200);
      })
    `)

    debug(`RecMan page state for ${archiveUrl}: ${JSON.stringify(recManState)}`)

    const isRecMan = Boolean(recManState && recManState.tableCount > 0)
    debug(`RecMan detection for ${archiveUrl}: ${String(isRecMan)}`)

    if (isRecMan) {
      debug(`Detected RecMan layout for ${archiveUrl}, using RecMan extractor`)
      const webexUrls = await extractWebExUrlsFromRecMan(archiveUrl)
      debug(
        `extractWebExUrlsFromRecMan returned ${Array.isArray(webexUrls) ? webexUrls.length : "non-array"}`,
      )
      const recordings: WebExRecording[] = []
      for (const candidate of webexUrls) {
        const { webexUrl } = candidate
        const recordingId = extractVideoID(webexUrl)
        if (!recordingId) continue

        let title = isMeaningfulRecordingTitle(candidate.title)
          ? candidate.title
          : `Recording ${recordingId}`
        const date = parseLectureDate(candidate.dateText || null)
        try {
          if (!isMeaningfulRecordingTitle(candidate.title)) {
            const streamInfo = await getWebExStreamInfo(webexUrl)
            if (streamInfo) {
              title = streamInfo.title
            }
          }
        } catch (e) {
          debug(`Could not get stream info for ${webexUrl}:`, e)
        }

        recordings.push({
          recordingId,
          title,
          webexUrl,
          recmanUrl: archiveUrl,
          date,
          courseId,
          courseName: courseName || `Course ${courseId}`,
          downloaded: false,
        })
      }

      return recordings
    }

    const rows = await recordingBrowser.executeScript(`
      const anchors = Array.from(document.querySelectorAll('a'));
      return anchors
        .map((a, index) => ({ href: a.href, text: a.textContent?.trim() || "", index }))
        .filter(item => item.href && item.text)
        .slice(0, 200);
    `)
    debug(
      `Anchor-based extraction returned ${Array.isArray(rows) ? rows.length : "non-array"}`,
    )

    const recordings: WebExRecording[] = []
    for (const row of rows) {
      const recordingId = extractVideoID(row.href)
      if (!recordingId) continue

      let title = row.text
      let date = new Date()

      try {
        const metadata = await recordingBrowser.executeScript(`
          const anchors = Array.from(document.querySelectorAll('a'));
          const anchor = anchors[${row.index}];
          if (!anchor) return null;
          const row = anchor.closest('tr');
          if (!row) return null;
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          return { title: anchor.textContent?.trim() || '', cells };
        `)
        if (metadata && metadata.cells && metadata.cells.length > 0) {
          title = metadata.title || title
          const dateText = metadata.cells.find((text: string) =>
            /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text),
          )
          if (dateText) {
            const parsed = parseLectureDate(dateText)
            if (!isNaN(parsed.getTime())) date = parsed
          }
        }
      } catch (e) {
        debug(
          `Unable to parse metadata row for ${JSON.stringify(row.href)}:`,
          e,
        )
      }

      recordings.push({
        recordingId,
        title,
        webexUrl: row.href,
        recmanUrl: archiveUrl,
        date,
        courseId,
        courseName: courseName || `Course ${courseId}`,
        downloaded: false,
      })
    }

    return recordings
  } catch (e) {
    error(
      `Failed to extract lecture metadata from archive ${archiveUrl}: ${String(e)}`,
    )
    if (e && (e as any).stack) error((e as any).stack)
    return []
  }
}

export async function getWebExTicketCookie(): Promise<string | null> {
  const cookies = await recordingBrowser.getCookies(
    "https://politecnicomilano.webex.com",
    ["ticket"],
  )
  return cookies.ticket || null
}

export async function getWebExStreamInfo(
  webexUrl: string,
): Promise<WebExStreamInfo | null> {
  const recordingId = extractVideoID(webexUrl)
  if (!recordingId) {
    error(`Could not extract recording ID from: ${webexUrl}`)
    return null
  }

  const ticket = await getWebExTicketCookie()
  if (!ticket) {
    throw new Error(
      "WebEx ticket cookie not found. Please log in to WeBeep first.",
    )
  }

  try {
    const response = await got.post(
      `https://politecnicomilano.webex.com/webappng/api/v1/recordings/${recordingId}/stream`,
      {
        headers: {
          Cookie: `ticket=${ticket}`,
          Accept: "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        },
        searchParams: { siteurl: "politecnicomilano" },
        responseType: "json",
        timeout: { request: 30000 },
      },
    )

    const data = response.body as any

    if (data.code === 53005) {
      throw new Error("Recording is password protected")
    }

    if (data.code === 54001) {
      throw new Error("Recording does not exist")
    }

    if (data.fallbackPlaySrc) {
      return {
        mp4Url: data.fallbackPlaySrc,
        title: data.recordName?.trim() || `Recording ${recordingId}`,
        recordingId,
      }
    }

    if (data.downloadRecordingInfo?.downloadInfo?.mp4URL) {
      return {
        mp4Url: data.downloadRecordingInfo.downloadInfo.mp4URL,
        title: data.recordName?.trim() || `Recording ${recordingId}`,
        recordingId,
      }
    }

    error("Unexpected WebEx API response:", data)
    return null
  } catch (e) {
    if (e.response?.statusCode === 401 || e.response?.statusCode === 403) {
      throw new Error("WebEx session expired. Please log in to WeBeep again.")
    }
    throw e
  }
}

export interface RecordingDiscoveryProgress {
  courseName: string
  coursesChecked: number
  coursesTotal: number
  activitiesChecked: number
  activityName?: string
}

export interface RecordingDiscoveryResult {
  recordings: WebExRecording[]
  coursesChecked: number
  activitiesChecked: number
  unsupportedActivities: number
  failures: string[]
}

export async function checkForNewRecordings(
  options: {
    force?: boolean
    onProgress?: (progress: RecordingDiscoveryProgress) => void
  } = {},
): Promise<RecordingDiscoveryResult> {
  const courses = await moodleClient.getCoursesWithoutCache()
  const syncableCourses = courses.filter(
    course =>
      moodleClient.cachedCourses.find(cached => cached.id === course.id)
        ?.shouldSync,
  )
  const unique = new Map<string, WebExRecording>()
  let activitiesChecked = 0
  let unsupportedActivities = 0
  let coursesChecked = 0
  const failures: string[] = []
  const state = (store.data.persistence.recordingDiscoveryState ||= {
    modules: {},
    archives: {},
  })
  const catalog = store.data.persistence.recordingCatalog || {}
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const scannedArchives = new Map<string, RecManRecordingCandidate[]>()

  const scanArchive = async (sourceUrl: string, context: string) => {
    if (scannedArchives.has(sourceUrl)) return scannedArchives.get(sourceUrl)!
    const saved = (state.archives[sourceUrl] ||= { knownCandidateUrls: [] })
    const full = options.force || now - (saved.lastFullCheckedAt || 0) >= day
    const known = new Set(saved.knownCandidateUrls)
    const failed = new Set<string>()
    const result = await extractWebExUrlsFromRecMan(sourceUrl, {
      knownCandidateUrls: full ? undefined : known,
      onCandidateResolved: url => known.add(url),
      onCandidateFailed: (url, message) => {
        failed.add(url)
        failures.push(`${context}: ${message} (${url})`)
      },
    })
    // A failed link is retried on the next scan, even if it worked previously.
    saved.knownCandidateUrls = Array.from(known).filter(url => !failed.has(url))
    if (full && !failed.size) saved.lastFullCheckedAt = now
    scannedArchives.set(sourceUrl, result)
    return result
  }

  for (const course of syncableCourses) {
    options.onProgress?.({
      courseName: course.name,
      coursesChecked,
      coursesTotal: syncableCourses.length,
      activitiesChecked,
    })
    try {
      const modules = await moodleClient.getRecordingModules(course)
      const hasArchive = modules.some(
        module =>
          isArchiveUrl(module.url) ||
          /archivio registrazioni|recordings archive/i.test(module.name),
      )
      if (!hasArchive) {
        const key = `${course.id}:${-course.id}`
        const cached = state.modules[key]
        let sourceUrl = cached?.kind === "archive" ? cached.sourceUrl : null
        if (
          !sourceUrl &&
          (options.force || !cached?.checkedAt || now - cached.checkedAt >= day)
        ) {
          try {
            sourceUrl = await getAunicaUrlFromWebeep(course.id)
            if (!sourceUrl)
              state.modules[key] = {
                sourceUrl: "",
                resolvedUrl: "",
                kind: "unsupported",
                checkedAt: now,
              }
          } catch (err) {
            failures.push(
              `${course.name}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (sourceUrl)
          modules.push({
            id: -course.id,
            name: "Archivio registrazioni",
            url: sourceUrl,
            courseId: course.id,
          })
      }
      for (const module of modules) {
        activitiesChecked++
        options.onProgress?.({
          courseName: course.name,
          coursesChecked,
          coursesTotal: syncableCourses.length,
          activitiesChecked,
          activityName: module.name,
        })
        const key = `${course.id}:${module.id}`
        const cached = state.modules[key]
        const fresh =
          !options.force &&
          cached?.sourceUrl === module.url &&
          cached.checkedAt &&
          now - cached.checkedAt <
            (cached.kind === "unsupported" ? day / 4 : day)
        let candidates: RecManRecordingCandidate[] = []
        let archiveUrl: string | undefined
        try {
          if (fresh && cached.kind === "unsupported") {
            unsupportedActivities++
            continue
          }
          if (cached?.sourceUrl === module.url && cached.kind === "archive") {
            // Re-enter through the source activity; RecMan session URLs may expire.
            archiveUrl = module.url
            candidates = await scanArchive(
              archiveUrl,
              `${course.name} / ${module.name}`,
            )
          } else if (
            fresh &&
            cached.kind === "webex" &&
            extractVideoID(cached.resolvedUrl)
          ) {
            candidates = [{ webexUrl: cached.resolvedUrl, title: module.name }]
          } else if (isWebExUrl(module.url)) {
            candidates = [
              {
                webexUrl: await resolveWebExRecordingUrl(module.url),
                title: module.name,
              },
            ]
          } else if (isArchiveUrl(module.url)) {
            archiveUrl = module.url
            candidates = await scanArchive(
              archiveUrl,
              `${course.name} / ${module.name}`,
            )
          } else {
            const resolved = await recordingBrowser.navigateInTemporaryWindow(
              module.url,
            )
            const webexUrl = resolvedRecordingUrl(
              [...resolved.urls, resolved.finalUrl],
              resolved.html,
              resolved.finalUrl,
            )
            if (webexUrl) {
              const pageUrls = extractCandidateUrlsFromHtml(
                resolved.html,
                resolved.finalUrl,
              ).filter(url => !!extractVideoID(url))
              candidates = Array.from(new Set([webexUrl, ...pageUrls])).map(
                url => ({ webexUrl: url, title: module.name }),
              )
            } else {
              const archiveLink = Array.from(
                resolved.html.matchAll(/["']([^"'<>]+)["']/g),
                match => normalizeRecordingUrl(match[1], resolved.finalUrl),
              ).find(url => !!url && isArchiveUrl(url))
              if (
                isArchiveUrl(resolved.finalUrl) ||
                archiveLink ||
                /archivio registrazioni|recordings archive/i.test(module.name)
              ) {
                archiveUrl = archiveLink || module.url
                candidates = await scanArchive(
                  archiveUrl,
                  `${course.name} / ${module.name}`,
                )
              } else if (
                /type\s*=\s*["']password/i.test(resolved.html) ||
                isWebExUrl(resolved.finalUrl)
              ) {
                throw new Error(
                  "The link requires sign-in or did not reach a recording. It will be retried.",
                )
              } else {
                unsupportedActivities++
                state.modules[key] = {
                  sourceUrl: module.url,
                  resolvedUrl: resolved.finalUrl,
                  kind: "unsupported",
                  checkedAt: now,
                }
                continue
              }
            }
          }
          if (archiveUrl) {
            state.modules[key] = {
              sourceUrl: module.url,
              resolvedUrl: archiveUrl,
              kind: "archive",
              checkedAt: now,
            }
          } else if (candidates.length === 1) {
            state.modules[key] = {
              sourceUrl: module.url,
              resolvedUrl: candidates[0].webexUrl,
              kind: "webex",
              checkedAt: now,
            }
          }
          for (const candidate of candidates) {
            const id = extractVideoID(candidate.webexUrl)
            if (!id) continue
            const known = catalog[id]?.recording
            let title =
              isMeaningfulRecordingTitle(candidate.title) &&
              !/archivio registrazioni|recordings archive/i.test(
                candidate.title,
              )
                ? candidate.title
                : `Recording ${id}`
            if (!isMeaningfulRecordingTitle(title)) {
              if (isMeaningfulRecordingTitle(known?.title)) title = known.title
              else if (!unique.has(id)) {
                try {
                  title =
                    (await getWebExStreamInfo(candidate.webexUrl))?.title ||
                    title
                } catch (err) {
                  debug(
                    `Could not retrieve recording title for ${id}: ${String(err)}`,
                  )
                }
              }
            }
            const recording: WebExRecording = {
              recordingId: id,
              title,
              webexUrl: candidate.webexUrl,
              recmanUrl: archiveUrl,
              sourceModuleId: module.id,
              sourceUrl: module.url,
              date: parseLectureDate(candidate.dateText) || known?.date || null,
              courseId: course.id,
              courseName: course.name,
              downloaded: known?.downloaded || false,
            }
            const previous = unique.get(id)
            if (
              !previous ||
              (known?.courseId === course.id && previous.courseId !== course.id)
            )
              unique.set(id, recording)
            else {
              if (!previous.date && recording.date)
                previous.date = recording.date
              if (
                !isMeaningfulRecordingTitle(previous.title) &&
                isMeaningfulRecordingTitle(recording.title)
              )
                previous.title = recording.title
            }
          }
        } catch (err) {
          // Never cache a failed navigation as an unrelated activity.
          delete state.modules[key]
          failures.push(
            `${course.name} / ${module.name}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    } catch (err) {
      failures.push(
        `${course.name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    coursesChecked++
  }
  options.onProgress?.({
    courseName: "",
    coursesChecked,
    coursesTotal: syncableCourses.length,
    activitiesChecked,
  })
  return {
    recordings: Array.from(unique.values()),
    coursesChecked,
    activitiesChecked,
    unsupportedActivities,
    failures,
  }
}
