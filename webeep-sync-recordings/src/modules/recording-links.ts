/** Pure parsing shared by discovery, manual additions and catalogue display. */
export function normalizeRecordingUrl(
  value: string,
  base?: string,
): string | null {
  if (!value.trim()) return null
  const decoded = value
    .trim()
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, String.fromCharCode(34))
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const point =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : Number(code)
      return point <= 0x10ffff ? String.fromCodePoint(point) : ""
    })
  try {
    const url = new URL(decoded, base)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null
    return url.href
  } catch {
    return null
  }
}

export function isWebExUrl(value: string): boolean {
  const normalized = normalizeRecordingUrl(value)
  if (!normalized) return false
  const host = new URL(normalized).hostname.toLowerCase()
  return host === "webex.com" || host.endsWith(".webex.com")
}

export function extractVideoID(value: string): string | null {
  if (!isWebExUrl(value) || isWebExMeetingUrl(value)) return null
  const url = new URL(normalizeRecordingUrl(value)!)
  for (const part of url.pathname.split("/")) {
    if (/^[a-f0-9]{32}$/i.test(part)) return part.toLowerCase()
  }
  for (const [key, id] of Array.from(url.searchParams.entries())) {
    if (key.toLowerCase() === "rcid" && /^[a-f0-9]{32}$/i.test(id))
      return id.toLowerCase()
  }
  return null
}

export function isWebExMeetingUrl(value: string): boolean {
  return (
    isWebExUrl(value) &&
    /\/(?:meet|joinservice|meeting)(?:\/|$)/i.test(
      new URL(normalizeRecordingUrl(value)!).pathname,
    )
  )
}

export function isArchiveUrl(value: string): boolean {
  const normalized = normalizeRecordingUrl(value)
  if (!normalized) return false
  const url = new URL(normalized)
  return (
    (url.hostname === "polimi.it" || url.hostname.endsWith(".polimi.it")) &&
    /recman|\/getservizio\.xml/i.test(url.pathname)
  )
}

export function isRecordingCandidate(value: string): boolean {
  if (isWebExUrl(value)) return !isWebExMeetingUrl(value)
  const normalized = normalizeRecordingUrl(value)
  if (!normalized) return false
  const url = new URL(normalized)
  return (
    (url.hostname === "polimi.it" || url.hostname.endsWith(".polimi.it")) &&
    /evn_preview_link|preview_link|transfer_id=/i.test(url.href)
  )
}

export function extractCandidateUrlsFromHtml(
  html: string,
  baseUrl: string,
): string[] {
  const urls = new Set<string>()
  const add = (value: string) => {
    const url = normalizeRecordingUrl(value, baseUrl)
    if (url && isRecordingCandidate(url)) urls.add(url)
  }
  // Attribute values, inline redirects and absolute URLs in serialized scripts.
  for (const match of Array.from(html.matchAll(/(?=["']([^"'<>]+)["'])/g)))
    add(match[1])
  const decoded = html
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
  for (const match of Array.from(decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)))
    add(match[0])
  return Array.from(urls)
}

export function resolvedRecordingUrl(
  urls: string[],
  html = "",
  baseUrl = "",
): string | null {
  const candidates = [...urls, ...extractCandidateUrlsFromHtml(html, baseUrl)]
  return (
    candidates.find(url => /\/playback\//i.test(url) && extractVideoID(url)) ||
    candidates.find(url => extractVideoID(url)) ||
    null
  )
}

export function parseLectureDate(value?: string | null): Date | null {
  if (!value?.trim()) return null
  // Italian dates must be parsed before JavaScript's US-oriented Date parser.
  const match = value.match(
    /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?\b/,
  )
  if (match) {
    const [, day, month, rawYear, hour = "0", minute = "0"] = match
    const year = Number(rawYear) + (rawYear.length === 2 ? 2000 : 0)
    const date = new Date(
      year,
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    )
    return date.getFullYear() === year &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day) &&
      Number(hour) < 24 &&
      Number(minute) < 60
      ? date
      : null
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
