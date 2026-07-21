import { EventEmitter } from "events"
import path from "path"
import fs from "fs/promises"
import { pipeline } from "stream/promises"
import got from "got"
import { createWriteStream } from "fs"
import { store, storeIsReady } from "./store"
import { loginManager } from "./login"
import {
  checkForNewRecordings,
  getWebExStreamInfo,
  getWebExTicketCookie,
} from "./recordings"
import { createLogger } from "./logger"
import {
  DownloadedRecording,
  RecordingCatalogItem,
  WebExRecording,
} from "./recordings-types"
import { transcriberWorker, TranscriberWorkerEvent } from "./transcriber-worker"

const { log, error } = createLogger("RecordingsManager")

export class RecordingsManager extends EventEmitter {
  private syncing = false
  private interval: NodeJS.Timeout | null = null
  private currentDownloads = new Map<string, { cancel: () => void }>()
  private transcriptionJobs = new Map<string, string>()

  constructor() {
    super()
    transcriberWorker.on("event", event => {
      this.handleTranscriberEvent(event).catch(err =>
        error(`Failed to handle Transcriber event: ${String(err)}`),
      )
    })
  }

  async startPolling(): Promise<void> {
    await storeIsReady()
    this.restartPolling()
    if (store.data.settings.recordingsEnabled && loginManager.isLogged) {
      setTimeout(() => {
        this.discoverRecordings().catch(err =>
          error(`Initial recordings discovery failed: ${String(err)}`),
        )
      }, 5000)
    }
  }

  restartPolling(): void {
    this.stopPolling()
    const intervalMs =
      (store.data.settings.recordingsSyncInterval || 30) * 60 * 1000
    this.interval = setInterval(() => {
      if (store.data.settings.recordingsEnabled && !this.syncing) {
        this.discoverRecordings().catch(err =>
          error(`Recordings discovery failed: ${String(err)}`),
        )
      }
    }, intervalMs)
    log(`Recordings polling started (interval: ${intervalMs / 60000} min)`)
  }

  stopPolling(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
  }

  async syncRecordings(): Promise<void> {
    await this.discoverRecordings()
  }

  async discoverRecordings(): Promise<void> {
    if (this.syncing) return
    await storeIsReady()
    this.syncing = true
    this.emit("sync-start")
    try {
      const discovery = await checkForNewRecordings()
      const discovered = discovery.recordings
      const catalog = this.getCatalog()
      let newCount = 0
      for (const recording of discovered) {
        const existing = catalog[recording.recordingId]
        if (existing) {
          existing.recording = recording
          continue
        }
        newCount++
        catalog[recording.recordingId] = {
          recording,
          discoveredAt: Date.now(),
          status: "available",
        }
      }
      store.data.persistence.recordingsLastChecked = Date.now()
      await store.write()
      this.emit("catalog", catalog)
      this.emit("sync-complete", {
        discovered: discovered.length,
        newCount,
        coursesChecked: discovery.coursesChecked,
        activitiesChecked: discovery.activitiesChecked,
        unsupportedActivities: discovery.unsupportedActivities,
        failures: discovery.failures,
      })

      if (store.data.settings.recordingsAutoDownload) {
        const ids = discovered
          .map(item => item.recordingId)
          .filter(id => catalog[id]?.status === "available")
        await this.downloadSelected(ids)
        if (store.data.settings.recordingsAutoTranscribe) {
          await this.transcribeSelected(ids)
        }
      }
    } catch (err) {
      this.emit("sync-error", err)
      throw err
    } finally {
      this.syncing = false
    }
  }

  getCatalog(): Record<string, RecordingCatalogItem> {
    if (!store.data.persistence.recordingCatalog) {
      store.data.persistence.recordingCatalog = {}
    }
    return store.data.persistence.recordingCatalog
  }

  async downloadSelected(recordingIds: string[]): Promise<void> {
    await storeIsReady()
    const pending = Array.from(new Set(recordingIds))
    const concurrency = Math.max(
      1,
      Math.min(5, store.data.settings.recordingsMaxConcurrent || 1),
    )
    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      async () => {
        while (pending.length) {
          const recordingId = pending.shift()
          if (!recordingId) return
          const item = this.getCatalog()[recordingId]
          if (!item || !["available", "error"].includes(item.status)) continue
          await this.downloadCatalogItem(item)
        }
      },
    )
    await Promise.all(workers)
  }

  private async downloadCatalogItem(item: RecordingCatalogItem): Promise<void> {
    const { recording } = item
    item.status = "downloading"
    item.error = undefined
    item.progress = 0
    this.emitItem(item)
    try {
      const filePath = await this.downloadRecording(recording, fraction => {
        item.progress = fraction
        this.emitItem(item)
      })
      item.status = "downloaded"
      item.filePath = filePath
      item.progress = 1
      this.markDownloaded(recording.recordingId, {
        webexUrl: recording.webexUrl,
        title: recording.title,
        courseId: recording.courseId,
        downloadedAt: Date.now(),
        filePath,
      })
      await store.write()
      this.emit("new-file", { recording, filePath })
      this.emitItem(item)
    } catch (err) {
      item.status = "error"
      item.error = err instanceof Error ? err.message : String(err)
      await store.write()
      this.emitItem(item)
    }
  }

  private async downloadRecording(
    recording: WebExRecording,
    onProgress: (fraction: number) => void,
  ): Promise<string> {
    const courseDir = path.join(
      store.data.settings.recordingsDownloadPath,
      recording.courseName.replace(/[/\\?%*:;|"<>]/g, "-"),
    )
    await fs.mkdir(courseDir, { recursive: true })
    const ticket = await getWebExTicketCookie()
    if (!ticket) {
      onProgress(0)
      try {
        const downloadedPath = await transcriberWorker.download({
          url: recording.webexUrl,
          outputDir: courseDir,
          onJobId: jobId =>
            this.currentDownloads.set(recording.recordingId, {
              cancel: () => transcriberWorker.cancel(jobId),
            }),
        })
        onProgress(1)
        return downloadedPath
      } finally {
        this.currentDownloads.delete(recording.recordingId)
      }
    }

    const streamInfo = await getWebExStreamInfo(recording.webexUrl)
    if (!streamInfo) throw new Error("Failed to get WebEx stream information.")
    const safeTitle = recording.title.replace(/[/\\?%*:;|"<>]/g, "-")
    const filePath = path.join(courseDir, `${safeTitle}.mp4`)
    const partialPath = `${filePath}.part`

    const controller = new AbortController()
    this.currentDownloads.set(recording.recordingId, {
      cancel: () => controller.abort(),
    })
    const source = got.stream(streamInfo.mp4Url, {
      headers: { Cookie: `ticket=${ticket}` },
      signal: controller.signal,
      timeout: { request: 300000 },
    })
    source.on("downloadProgress", progress => onProgress(progress.percent))
    try {
      await pipeline(source, createWriteStream(partialPath))
      await fs.rename(partialPath, filePath)
      return filePath
    } catch (err) {
      await fs.unlink(partialPath).catch(() => {})
      if (controller.signal.aborted) throw new Error("Download cancelled.")
      throw err
    } finally {
      this.currentDownloads.delete(recording.recordingId)
    }
  }

  cancelDownload(recordingId: string): boolean {
    const download = this.currentDownloads.get(recordingId)
    if (!download) return false
    download.cancel()
    return true
  }

  async transcribeSelected(recordingIds: string[]): Promise<void> {
    await storeIsReady()
    for (const recordingId of Array.from(new Set(recordingIds))) {
      const item = this.getCatalog()[recordingId]
      if (!item?.filePath || !["downloaded", "error"].includes(item.status)) {
        continue
      }
      item.status = "transcribing"
      item.error = undefined
      item.progress = 0
      const jobId = await transcriberWorker.start({
        recordingId,
        mediaPath: item.filePath,
        sourceUrl: item.recording.webexUrl,
      })
      this.transcriptionJobs.set(jobId, recordingId)
      this.emitItem(item)
    }
    await store.write()
  }

  cancelTranscription(recordingId: string): boolean {
    const pair = Array.from(this.transcriptionJobs.entries()).find(
      ([, id]) => id === recordingId,
    )
    if (!pair) return false
    const cancelled = transcriberWorker.cancel(pair[0])
    if (cancelled) {
      this.transcriptionJobs.delete(pair[0])
      const item = this.getCatalog()[recordingId]
      if (item) {
        item.status = item.filePath ? "downloaded" : "available"
        item.progress = undefined
        item.error = "Transcription cancelled."
        store.write()
        this.emitItem(item)
      }
    }
    return cancelled
  }

  private async handleTranscriberEvent(
    event: TranscriberWorkerEvent,
  ): Promise<void> {
    const recordingId = this.transcriptionJobs.get(event.job_id)
    if (!recordingId) return
    const item = this.getCatalog()[recordingId]
    if (!item) return
    if (event.type === "progress") {
      item.status = event.stage === "complete" ? "completed" : "transcribing"
      item.progress = event.fraction
    } else if (event.type === "complete") {
      item.status = "completed"
      item.progress = 1
      item.transcriptPath = event.artifacts?.transcript_txt || undefined
      item.notesPath = event.artifacts?.notes_markdown || undefined
      this.transcriptionJobs.delete(event.job_id)
    } else {
      item.status = "error"
      item.error = event.message || event.code || "Transcription failed."
      this.transcriptionJobs.delete(event.job_id)
    }
    await store.write()
    this.emitItem(item)
  }

  private emitItem(item: RecordingCatalogItem): void {
    this.emit("progress", {
      recordingId: item.recording.recordingId,
      status: item.status,
      progress: item.progress,
      error: item.error,
      item,
    })
  }

  private getDownloadedRecordings(): Record<string, DownloadedRecording> {
    return store.data.persistence.downloadedRecordings || {}
  }

  private markDownloaded(recordingId: string, info: DownloadedRecording): void {
    if (!store.data.persistence.downloadedRecordings) {
      store.data.persistence.downloadedRecordings = {}
    }
    store.data.persistence.downloadedRecordings[recordingId] = info
  }

  getDownloadedRecordingsList(): Record<string, DownloadedRecording> {
    return this.getDownloadedRecordings()
  }

  async deleteRecording(recordingId: string): Promise<boolean> {
    const catalogItem = this.getCatalog()[recordingId]
    const downloaded = this.getDownloadedRecordings()[recordingId]
    const filePath = catalogItem?.filePath || downloaded?.filePath
    if (filePath) await fs.unlink(filePath).catch(() => {})
    delete this.getDownloadedRecordings()[recordingId]
    if (catalogItem) {
      catalogItem.filePath = undefined
      catalogItem.status = "available"
      catalogItem.progress = undefined
    }
    await store.write()
    if (catalogItem) this.emitItem(catalogItem)
    return true
  }

  async openRecording(recordingId: string): Promise<void> {
    const { shell } = await import("electron")
    const filePath =
      this.getCatalog()[recordingId]?.filePath ||
      this.getDownloadedRecordings()[recordingId]?.filePath
    if (filePath) await shell.openPath(filePath)
  }

  getSyncState(): { syncing: boolean } {
    return { syncing: this.syncing }
  }
}

export const recordingsManager = new RecordingsManager()
