import type { RecordingCatalogItem } from "./recordings-types"

export function canDownload(item: RecordingCatalogItem): boolean {
  return !item.filePath && ["available", "error"].includes(item.status)
}
export function canTranscribe(item: RecordingCatalogItem): boolean {
  return !!item.filePath && ["downloaded", "error"].includes(item.status)
}
export function isRecordingBusy(item: RecordingCatalogItem): boolean {
  return ["downloading", "queued", "transcribing"].includes(item.status)
}
export type RecordingFilter =
  | "all"
  | "available"
  | "downloaded"
  | "active"
  | "completed"
  | "error"
export type RecordingSort = "newest" | "oldest" | "title"
export function groupRecordings(
  items: RecordingCatalogItem[],
  query: string,
  filter: RecordingFilter,
  sort: RecordingSort,
) {
  const search = query.trim().toLocaleLowerCase()
  const groups = new Map<
    number,
    { courseId: number; courseName: string; items: RecordingCatalogItem[] }
  >()
  for (const item of items) {
    const recording = item.recording
    if (
      search &&
      !`${recording.title} ${recording.courseName}`
        .toLocaleLowerCase()
        .includes(search)
    )
      continue
    if (filter === "available" && !canDownload(item)) continue
    if (filter === "downloaded" && !item.filePath) continue
    if (filter === "active" && !isRecordingBusy(item)) continue
    if (["completed", "error"].includes(filter) && item.status !== filter)
      continue
    const group = groups.get(recording.courseId) || {
      courseId: recording.courseId,
      courseName: recording.courseName,
      items: [],
    }
    group.items.push(item)
    groups.set(recording.courseId, group)
  }
  const compareTitle = (a: RecordingCatalogItem, b: RecordingCatalogItem) =>
    a.recording.title.localeCompare(b.recording.title, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || a.recording.recordingId.localeCompare(b.recording.recordingId)
  const timestamp = (item: RecordingCatalogItem) =>
    item.recording.date ? new Date(item.recording.date).getTime() || 0 : 0
  for (const group of Array.from(groups.values())) {
    group.items.sort((a, b) => {
      if (sort === "title") return compareTitle(a, b)
      const first = timestamp(a),
        second = timestamp(b)
      if (!first || !second)
        return (!first ? 1 : 0) - (!second ? 1 : 0) || compareTitle(a, b)
      return (
        (sort === "newest" ? second - first : first - second) ||
        compareTitle(a, b)
      )
    })
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      a.courseName.localeCompare(b.courseName, undefined, {
        numeric: true,
        sensitivity: "base",
      }) || a.courseId - b.courseId,
  )
}
