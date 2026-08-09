export interface RecordingModule {
  id: number
  name: string
  url: string
  courseId: number
}

export interface WebExRecording {
  recordingId: string
  title: string
  webexUrl: string
  recmanUrl?: string
  sourceModuleId?: number
  sourceUrl?: string
  date: Date
  courseId: number
  courseName: string
  downloaded: boolean
}

export interface WebExStreamInfo {
  mp4Url: string
  title: string
  recordingId: string
}

export interface DownloadedRecording {
  webexUrl: string
  title: string
  courseId: number
  downloadedAt: number
  filePath: string
}

export type RecordingJobStatus =
  | "available"
  | "downloading"
  | "downloaded"
  | "queued"
  | "transcribing"
  | "completed"
  | "error"
  | "unsupported"

export interface RecordingCatalogItem {
  recording: WebExRecording
  discoveredAt: number
  status: RecordingJobStatus
  filePath?: string
  transcriptPath?: string
  notesPath?: string
  progress?: number
  error?: string
}

export interface SPIDCredentials {
  username: string
  password: string
  polimiEmail: string
}
