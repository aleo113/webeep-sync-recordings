import got from "got"
import { session } from "electron"
import { recordingBrowser } from "./browser-recorder"
import { moodleClient } from "./moodle"
import { createLogger } from "./logger"
import { WebExRecording, WebExStreamInfo } from "./recordings-types"
import { store } from "./store"

/* eslint-disable no-useless-escape, @typescript-eslint/no-explicit-any */

const { log, debug, error } = createLogger("Recordings")

function extractVideoID(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/")
    for (const part of parts) {
      if (part.length === 32 && /^[a-f0-9]{32}$/i.test(part)) return part
      if (part.length > 32) {
        const first32 = part.slice(0, 32)
        if (/^[a-f0-9]{32}$/i.test(first32)) return first32
      }
    }
    const rcid = u.searchParams.get("RCID") || u.searchParams.get("rcid")
    return rcid || null
  } catch {
    return null
  }
}

async function canonicalizeWebExUrl(url: string): Promise<string> {
  if (!url.includes("ldr.php")) return url
  const navigatedUrls = await recordingBrowser.navigateAndCollectUrls(url)
  return (
    navigatedUrls.find(
      candidate =>
        candidate.includes("webex.com") &&
        candidate.includes("/playback/") &&
        extractVideoID(candidate),
    ) || url
  )
}

export async function getAunicaUrlFromWebeep(
  courseId: number,
): Promise<string | null> {
  const courseUrl = `https://webeep.polimi.it/course/view.php?id=${courseId}&section=3`

  try {
    log(`getAunicaUrlFromWebeep start for course ${courseId}`)
    log(`Navigating to WeBeep course page ${courseUrl}`)
    // A single-quoted selector avoids escaping the embedded attribute quotes.
    // eslint-disable-next-line quotes
    await recordingBrowser.navigateAndWait(courseUrl, 'a[href*="auth"]', 15000)

    const loginClicked = await recordingBrowser.executeScript(`
      const btn = document.querySelector('a[href*="auth"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    `)

    if (loginClicked) {
      await new Promise(r => setTimeout(r, 3000))
    }

    const pageDebug = await recordingBrowser.executeScript(`
      const anchors = Array.from(document.querySelectorAll('a'));
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      return {
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        anchorCount: anchors.length,
        buttonCount: buttons.length,
        sampleAnchors: anchors.slice(0, 20).map(a => ({ text: a.textContent?.trim().slice(0, 50) || '', href: a.href || null })),
        sampleButtons: buttons.slice(0, 20).map(b => ({ text: b.textContent?.trim().slice(0, 50) || '', href: b.href || b.getAttribute('data-href') || null, onclick: b.getAttribute('onclick') || null })),
      };
    `)
    log(`WeBeep course page render state: ${JSON.stringify(pageDebug)}`)

    const aunicaUrl = await recordingBrowser.executeScript(`
      const links = Array.from(document.querySelectorAll('#page-content a, .page-content a, a, button, [role="button"]'));
      const normalized = (value) => (value || '').toLowerCase();
      const link = links.find(el => {
        const text = normalized(el.textContent || el.innerText || '');
        const href = normalized(el.href || el.getAttribute('data-href') || '');
        const onclick = normalized(el.getAttribute('onclick') || '');
        const id = normalized(el.id || '');
        const className = normalized(el.className || '');
        return (
          text.includes('archivio registrazioni') ||
          text.includes('recordings archive') ||
          text.includes('recman') ||
          text.includes('registrazioni') ||
          href.includes('getservizio.xml') ||
          href.includes('aunicalogin.polimi.it/aunicalogin/getservizio.xml') ||
          href.includes('recman_frontend') ||
          onclick.includes('recman') ||
          onclick.includes('getservizio') ||
          id.includes('recman') ||
          className.includes('recman')
        );
      });
      if (!link) return null;
      return link.href || link.getAttribute('data-href') || link.getAttribute('onclick') || null;
    `)

    if (!aunicaUrl) {
      log(
        "No 'Archivio registrazioni' link found, checking for direct recording links",
      )
      const directUrl = await recordingBrowser.executeScript(`
        const links = Array.from(document.querySelectorAll('a'));
        return links
          .map(a => a.href || '')
          .find(href => href && (
            href.includes('aunicalogin.polimi.it/aunicalogin/getservizio.xml') ||
            href.includes('getservizio.xml') ||
            href.includes('recman_frontend') ||
            href.includes('evn_preview_link')
          )) || null;
      `)
      log(`Direct archive URL fallback result: ${directUrl || "<none>"}`)
      return directUrl
    }

    log(
      `Archive-link discovery on WeBeep course page returned: ${aunicaUrl || "<none>"}`,
    )

    if (aunicaUrl) {
      log(`Navigating to discovered archive URL: ${aunicaUrl}`)
    }

    await recordingBrowser.navigateAndWait(aunicaUrl)

    const finalUrl = await recordingBrowser.executeScript(`
      const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const found = links.find(el => {
        const href = el.href || el.getAttribute('data-href') || '';
        const onclick = el.getAttribute('onclick') || '';
        return href.includes('aunicalogin.polimi.it/aunicalogin/getservizio.xml') || href.includes('recman_frontend') || onclick.includes('recman') || onclick.includes('getservizio');
      });
      if (!found) return null;
      return found.href || found.getAttribute('data-href') || found.getAttribute('onclick') || null;
    `)

    log(
      `getAunicaUrlFromWebeep finished for course ${courseId}, finalUrl=${finalUrl || "<none>"}`,
    )
    return finalUrl
  } catch (e) {
    error(`Failed to get aunica URL for course ${courseId}:`, e)
    return null
  }
}

async function fetchRecManHtml(url: string): Promise<string | null> {
  try {
    const targetUrl = new URL(url)
    const cookies = await session.defaultSession.cookies.get({
      url: targetUrl.origin,
    })
    const cookieHeader = cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join("; ")

    const response = await got.get(url, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      followRedirect: true,
      responseType: "text",
      timeout: { request: 30000 },
    })

    return response.body || null
  } catch (e) {
    debug(`Authenticated HTML fetch failed for ${url}:`, e)
    return null
  }
}

function extractCandidateUrlsFromHtml(html: string, baseUrl: string): string[] {
  const urls = new Set<string>()
  const addUrl = (href: string | null | undefined) => {
    if (!href) return
    const trimmed = href.trim()
    if (!trimmed) return
    try {
      const normalized = new URL(trimmed, baseUrl).href
      if (
        normalized.includes("webex.com") ||
        normalized.includes("evn_preview_link") ||
        normalized.includes("preview_link") ||
        normalized.includes("transfer_id=") ||
        normalized.includes("getservizio.xml") ||
        normalized.includes("aunicalogin.polimi.it") ||
        normalized.includes("recman_frontend") ||
        normalized.includes("recording")
      ) {
        urls.add(normalized)
      }
    } catch {
      if (
        trimmed.includes("webex.com") ||
        trimmed.includes("evn_preview_link") ||
        trimmed.includes("preview_link") ||
        trimmed.includes("transfer_id=") ||
        trimmed.includes("getservizio.xml") ||
        trimmed.includes("aunicalogin.polimi.it") ||
        trimmed.includes("recman_frontend") ||
        trimmed.includes("recording")
      ) {
        urls.add(trimmed)
      }
    }
  }

  const hrefRegex = /href=["']([^"']+)["']/gi
  for (const match of Array.from(html.matchAll(hrefRegex))) addUrl(match[1])

  const urlRegex = /https?:\/\/[^\s"'<>]+/gi
  for (const match of Array.from(html.matchAll(urlRegex))) addUrl(match[0])

  return Array.from(urls)
}

interface RecManRecordingCandidate {
  webexUrl: string
  title?: string
  dateText?: string
}

export async function extractWebExUrlsFromRecMan(
  recmanUrl: string,
): Promise<RecManRecordingCandidate[]> {
  log(`extractWebExUrlsFromRecMan start for: ${recmanUrl}`)
  try {
    const pageDebug = await recordingBrowser.executeScript(`
      return ({
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        anchorCount: document.querySelectorAll('a').length,
        iframeCount: document.querySelectorAll('iframe, frame').length,
        bodySnippet: document.body?.innerText?.slice(0, 1000) || ''
      })
    `)
    log(
      `RecMan page initial state before navigation: ${JSON.stringify(pageDebug)}`,
    )

    await recordingBrowser.navigateAndWait(
      recmanUrl,
      ".TableDati, .TableDati-tbody, #form_tabella_transfers, table[class*='Table'], a[href], iframe, frame",
      30000,
    )
    await new Promise(r => setTimeout(r, 2000))

    const afterDebug = await recordingBrowser.executeScript(`
      return ({
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        anchorCount: document.querySelectorAll('a').length,
        iframeCount: document.querySelectorAll('iframe, frame').length,
        bodySnippet: document.body?.innerText?.slice(0, 1000) || ''
      })
    `)
    log(`RecMan page state after navigation: ${JSON.stringify(afterDebug)}`)

    const html = await fetchRecManHtml(recmanUrl)
    const htmlUrls = html ? extractCandidateUrlsFromHtml(html, recmanUrl) : []
    log(`extractWebExUrlsFromRecMan fetched html candidates=${htmlUrls.length}`)

    let recordingUrls: Array<{
      href: string
      title?: string
      dateText?: string
    }> = []
    try {
      recordingUrls = await recordingBrowser.executeScript(`
        return Array.from(document.querySelectorAll('a[href], area[href]'))
          .map(element => {
            const href = element.href || '';
            const row = element.closest('tr');
            const cells = row
              ? Array.from(row.querySelectorAll('td'))
                  .map(cell => (cell.textContent || '').replace(/\\s+/g, ' ').trim())
                  .filter(Boolean)
              : [];
            const dateText = cells.find(text => /\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}/.test(text));
            const generic = /^(video|webex|link|apri|open|vedi|visualizza|download|registrazione)$/i;
            const title = cells
              .filter(text => text !== dateText && !generic.test(text) && text.length > 3)
              .sort((a, b) => b.length - a.length)[0];
            return { href, title, dateText };
          })
          .filter(item =>
            item.href.includes('webex.com') ||
            item.href.includes('evn_preview_link') ||
            item.href.includes('preview_link') ||
            item.href.includes('transfer_id=') ||
            item.href.includes('recording')
          );
      `)
    } catch (e) {
      debug(
        `RecMan DOM scan failed; continuing with ${htmlUrls.length} authenticated HTML candidates: ${String(e)}`,
      )
    }

    const combinedByUrl = new Map<
      string,
      { href: string; title?: string; dateText?: string }
    >()
    for (const candidate of recordingUrls || []) {
      combinedByUrl.set(candidate.href, candidate)
    }
    for (const href of htmlUrls) {
      if (!combinedByUrl.has(href)) combinedByUrl.set(href, { href })
    }
    const combinedUrls = Array.from(combinedByUrl.values())
    log(
      `RecMan candidate URL counts: dom=${recordingUrls?.length || 0}, html=${htmlUrls.length}, combined=${combinedUrls.length}`,
    )
    log(`RecMan candidate URLs: ${JSON.stringify(combinedUrls.slice(0, 50))}`)

    if (!combinedUrls || combinedUrls.length === 0) {
      log(`No RecMan candidate URLs found for ${recmanUrl}`)
      const pageInfo = await recordingBrowser.executeScript(`
        const rows = Array.from(document.querySelectorAll('table.TableDati tr, .TableDati-tbody tr, .TableDati tr, #form_tabella_transfers tr, table[class*="Table"] tr'));
        const hrefs = Array.from(document.querySelectorAll('a[href]')).map(a => a.href).slice(0, 20);
        return {
          rowCount: rows.length,
          hrefCount: hrefs.length,
          hrefs,
          pageTitle: document.title,
          location: window.location.href,
          bodySnippet: document.body?.innerText?.slice(0, 1000) || '',
        };
      `)
      debug(
        `No recordings found in RecMan page; rows=${pageInfo?.rowCount}, hrefs=${pageInfo?.hrefCount}, page=${pageInfo?.pageTitle}, url=${pageInfo?.location}`,
      )
      debug(`RecMan page links: ${JSON.stringify(pageInfo?.hrefs || [])}`)
      debug(`RecMan body snippet: ${pageInfo?.bodySnippet || ""}`)
      debug(`RecMan HTML candidates: ${JSON.stringify(htmlUrls)}`)
      debug(`No RecMan candidates found for ${recmanUrl}`)
      return []
    }

    log(
      `extractWebExUrlsFromRecMan will attempt ${combinedUrls.length} candidate URLs`,
    )

    const webexUrls: RecManRecordingCandidate[] = []
    for (const candidate of combinedUrls) {
      const recUrl = candidate.href
      try {
        if (recUrl.includes("webex.com") && extractVideoID(recUrl)) {
          webexUrls.push({
            webexUrl: await canonicalizeWebExUrl(recUrl),
            title: candidate.title,
            dateText: candidate.dateText,
          })
          continue
        }
        await recordingBrowser.navigateAndWait(recUrl)

        const webexUrl = await recordingBrowser.executeScript(`
          const redirect = document.body.innerHTML.match(/location\\.href\s*=\s*['\"](.*?)['\"]/);
          if (redirect) return redirect[1];
          const windowLocation = window.location.href;
          return windowLocation && windowLocation.includes('webex.com') ? windowLocation : null;
        `)

        if (webexUrl && webexUrl.includes("webex.com")) {
          webexUrls.push({
            webexUrl,
            title: candidate.title,
            dateText: candidate.dateText,
          })
        }
      } catch (e) {
        debug(`Failed to extract WebEx URL from ${recUrl}:`, e)
      }
    }

    const uniqueByRecordingId = new Map<string, RecManRecordingCandidate>()
    for (const candidate of webexUrls) {
      const recordingId = extractVideoID(candidate.webexUrl)
      if (recordingId && !uniqueByRecordingId.has(recordingId)) {
        uniqueByRecordingId.set(recordingId, candidate)
      }
    }
    return Array.from(uniqueByRecordingId.values())
  } catch (e) {
    error(`Failed to extract WebEx URLs from RecMan: ${String(e)}`)
    if (e && (e as any).stack) error((e as any).stack)
    return []
  }
}

function parseLectureDate(dateText: string | null): Date {
  if (!dateText) return new Date()
  const normalized = dateText.trim().replace(/-/g, "/")
  const parsed = new Date(normalized)
  if (!isNaN(parsed.getTime())) return parsed

  const match = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (match) {
    const day = Number(match[1])
    const month = Number(match[2])
    let year = Number(match[3])
    if (year < 100) year += 2000
    return new Date(year, month - 1, day)
  }

  return new Date()
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

        let title = candidate.title || `Recording ${recordingId}`
        const date = parseLectureDate(candidate.dateText || null)
        try {
          if (!candidate.title) {
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

export interface RecordingDiscoveryResult {
  recordings: WebExRecording[]
  coursesChecked: number
  activitiesChecked: number
  unsupportedActivities: number
  failures: string[]
}

export async function checkForNewRecordings(): Promise<RecordingDiscoveryResult> {
  const courses = await moodleClient.getCoursesWithoutCache()
  const syncableCourses = courses.filter(
    c =>
      moodleClient.cachedCourses.find(cached => cached.id === c.id)?.shouldSync,
  )

  const allRecordings: WebExRecording[] = []
  let activitiesChecked = 0
  let unsupportedActivities = 0
  const failures: string[] = []

  for (const course of syncableCourses) {
    try {
      const modules = await moodleClient.getRecordingModules(course)
      const savedArchiveUrl =
        store.data.persistence.courses[course.id]?.archiveUrl?.trim()
      if (
        savedArchiveUrl &&
        !modules.some(module => module.url === savedArchiveUrl)
      ) {
        modules.push({
          id: -course.id,
          name: "Saved recordings archive",
          url: savedArchiveUrl,
          courseId: course.id,
        })
      }

      for (const module of modules) {
        activitiesChecked++
        const webexUrls: RecManRecordingCandidate[] = []
        let archiveUrl: string | undefined
        try {
          if (module.url.includes("webex.com") && extractVideoID(module.url)) {
            webexUrls.push({
              webexUrl: await canonicalizeWebExUrl(module.url),
              title: module.name.trim() || undefined,
            })
          } else {
            await recordingBrowser.navigateAndWait(module.url)
            await new Promise(resolve => setTimeout(resolve, 750))
            const resolvedUrl = await recordingBrowser.executeScript(
              "return window.location.href",
            )
            const moduleName = module.name.toLowerCase()
            const looksLikeArchive =
              moduleName.includes("archivio registrazioni") ||
              moduleName.includes("recordings archive") ||
              String(resolvedUrl).includes("recman") ||
              String(resolvedUrl).includes("getservizio.xml")

            if (String(resolvedUrl).includes("webex.com")) {
              webexUrls.push({
                webexUrl: String(resolvedUrl),
                title: module.name.trim() || undefined,
              })
            } else if (looksLikeArchive) {
              archiveUrl = String(resolvedUrl)
              webexUrls.push(...(await extractWebExUrlsFromRecMan(archiveUrl)))
            } else {
              unsupportedActivities++
              debug(
                `Ignoring unrelated URL activity ${module.id} (${module.name}): ${resolvedUrl}`,
              )
            }
          }
        } catch (e) {
          failures.push(
            `${course.name} / ${module.name}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
          error(
            `Failed to resolve recording module ${module.id} (${module.name}):`,
            e,
          )
          continue
        }

        for (const candidate of webexUrls) {
          const { webexUrl } = candidate
          const recordingId = extractVideoID(webexUrl)
          if (!recordingId) continue

          const moduleTitle = module.name.trim()
          const normalizedModuleTitle = moduleTitle.toLowerCase()
          const genericModuleTitle =
            normalizedModuleTitle.includes("archivio registrazioni") ||
            normalizedModuleTitle.includes("recordings archive") ||
            normalizedModuleTitle === "saved recordings archive"
          let title =
            candidate.title ||
            (genericModuleTitle
              ? `Recording ${recordingId}`
              : moduleTitle || `Recording ${recordingId}`)
          try {
            if (!candidate.title) {
              const streamInfo = await getWebExStreamInfo(webexUrl)
              if (streamInfo) title = streamInfo.title
            }
          } catch (e) {
            debug(`Could not get title for ${recordingId}:`, e)
          }

          allRecordings.push({
            recordingId,
            title,
            webexUrl,
            recmanUrl: archiveUrl,
            sourceModuleId: module.id,
            sourceUrl: module.url,
            date: parseLectureDate(candidate.dateText || null),
            courseId: course.id,
            courseName: course.name,
            downloaded: false,
          })
        }
      }
    } catch (e) {
      failures.push(
        `${course.name}: ${e instanceof Error ? e.message : String(e)}`,
      )
      error(`Failed to check recordings for course ${course.name}:`, e)
    }
  }

  return {
    recordings: allRecordings,
    coursesChecked: syncableCourses.length,
    activitiesChecked,
    unsupportedActivities,
    failures,
  }
}
