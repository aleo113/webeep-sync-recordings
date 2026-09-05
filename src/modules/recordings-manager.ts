import { EventEmitter } from "events"
import path from "path"
import fs from "fs/promises"
import { pipeline } from "stream/promises"
import got from "got"
import { createWriteStream } from "fs"
import { store, storeIsReady } from "./store"
import { loginManager } from "./login"
import { credentialsManager } from "./credentials"
import {
  browserSessionNeedsLogin,
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

function isFallbackRecordingTitle(title: string, recordingId: string): boolean {
  const normalized = title.trim().toLowerCase()
  return (
    !normalized ||
    normalized === recordingId.toLowerCase() ||
    normalized === `recording ${recordingId}`.toLowerCase() ||
    /^\d+\s*(?:min|mins|minutes|minuti)$/i.test(normalized)
  )
}

function titleFromMediaPath(filePath: string): string | null {
  const title = path.parse(filePath).name.trim()
  return title && !/^[a-f0-9]{32}$/i.test(title) ? title : null
}

export class RecordingsManager extends EventEmitter {
  private syncing = false
  private interval: NodeJS.Timeout | null = null
  private currentDownloads = new Map<string, { cancel: () => void }>()
  private transcriptionJobs = new Map<
    string,
    { recordingId: string; mediaPath: string }
  >()
  private transcriptionQueue: string[] = []
  private pumpingTranscriptions = false

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
    await this.recoverInterruptedJobs()
    this.restartPolling()
    if (store.data.settings.recordingsEnabled && loginManager.isLogged) {
      setTimeout(() => {
        this.discoverRecordings().catch(err =>
          error(`Initial recordings discovery failed: ${String(err)}`),
        )
      }, 5000)
    }
  }

  private async recoverInterruptedJobs(): Promise<void> {
    const catalog = this.getCatalog()
    let recovered = false
    for (const item of Object.values(catalog)) {
      if (item.status === "downloading") {
        item.status = item.filePath ? "downloaded" : "available"
        item.progress = undefined
        item.error = "Download was interrupted. You can start it again."
        recovered = true
        continue
      }
      if (!["queued", "transcribing"].includes(item.status)) continue
      item.status = item.filePath ? "downloaded" : "available"
      item.progress = undefined
      item.transcriptionStage = undefined
      item.error = "Transcription was interrupted. You can start it again."
      recovered = true
    }
    if (!recovered) return
    await store.write()
    this.emit("catalog", catalog)
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
      // The Moodle token alone is not enough here: discovery drives the
      // hidden browser through WeBeep, which needs live SSO cookies. When the
      // session has expired, prompt the interactive login before scanning.
      if (await browserSessionNeedsLogin()) {
        log("Browser session expired; requesting interactive login")
        const loggedIn = await loginManager.createLoginWindow()
        if (!loggedIn) {
          throw new Error(
            "Login WeBeep richiesto: completa l'accesso per cercare le registrazioni.",
          )
        }
      }
      const discovery = await checkForNewRecordings()
      const discovered = discovery.recordings
      const catalog = this.getCatalog()
      let newCount = 0
      for (const recording of discovered) {
        const existing = catalog[recording.recordingId]
        if (existing) {
          if (
            isFallbackRecordingTitle(recording.title, recording.recordingId) &&
            !isFallbackRecordingTitle(
              existing.recording.title,
              recording.recordingId,
            )
          ) {
            recording.title = existing.recording.title
          }
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
    const catalog = store.data.persistence.recordingCatalog
    for (const item of Object.values(catalog)) {
      if (
        item.filePath &&
        isFallbackRecordingTitle(
          item.recording.title,
          item.recording.recordingId,
        )
      ) {
        item.recording.title =
          titleFromMediaPath(item.filePath) || item.recording.title
      }
    }
    return catalog
  }

  async addManualRecording(webexUrl: string): Promise<RecordingCatalogItem> {
    await storeIsReady()
    const trimmedUrl = webexUrl.trim()
    let parsedUrl: URL
    try {
      parsedUrl = new URL(trimmedUrl)
    } catch {
      throw new Error("Invalid recording link")
    }
    if (!parsedUrl.hostname.toLowerCase().endsWith("webex.com")) {
      throw new Error("The link must be a WebEx recording link")
    }

    const recordingId =
      parsedUrl.pathname
        .split("/")
        .map(part => part.slice(0, 32))
        .find(part => /^[a-f0-9]{32}$/i.test(part)) ||
      parsedUrl.searchParams.get("RCID") ||
      parsedUrl.searchParams.get("rcid")
    if (!recordingId) {
      throw new Error("Could not identify a recording in this link")
    }

    const streamInfo = await getWebExStreamInfo(trimmedUrl)
    const catalog = this.getCatalog()
    const existing = catalog[recordingId]
    const item: RecordingCatalogItem = {
      recording: {
        recordingId,
        title:
          streamInfo?.title ||
          existing?.recording.title ||
          `Recording ${recordingId}`,
        webexUrl: trimmedUrl,
        date: existing?.recording.date || new Date(),
        courseId: existing?.recording.courseId || 0,
        courseName: existing?.recording.courseName || "Manual recordings",
        downloaded: Boolean(existing?.recording.downloaded),
      },
      discoveredAt: existing?.discoveredAt || Date.now(),
      status: existing?.status || "available",
      ...(existing?.filePath ? { filePath: existing.filePath } : {}),
    }
    catalog[recordingId] = item
    await store.write()
    this.emit("catalog", catalog)
    return item
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
      if (isFallbackRecordingTitle(recording.title, recording.recordingId)) {
        recording.title = titleFromMediaPath(filePath) || recording.title
      }
      item.status = "downloaded"
      item.filePath = filePath
      item.mediaRecordingId = recording.recordingId
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
      const attemptDir = await fs.mkdtemp(
        path.join(courseDir, `.webeep-download-${recording.recordingId}-`),
      )
      try {
        const downloadedPath = await transcriberWorker.download({
          url: recording.webexUrl,
          // PoliWebex's runner falls back to the newest media file in its
          // output directory. A fresh directory prevents a failed download
          // from being mistaken for a different, pre-existing recording.
          outputDir: attemptDir,
          spidCredentials: await credentialsManager.load(),
          onJobId: jobId =>
            this.currentDownloads.set(recording.recordingId, {
              cancel: () => transcriberWorker.cancel(jobId),
            }),
        })
        const relativePath = path.relative(attemptDir, downloadedPath)
        if (
          relativePath.startsWith("..") ||
          path.isAbsolute(relativePath) ||
          relativePath === ""
        ) {
          throw new Error(
            "Downloader returned a media file from outside this download attempt.",
          )
        }
        const hasAriaResumeFile = await fs
          .access(`${downloadedPath}.aria2`)
          .then(() => true)
          .catch(() => false)
        if (hasAriaResumeFile) {
          throw new Error("Downloader returned an incomplete media file.")
        }
        const finalPath = path.join(courseDir, path.basename(downloadedPath))
        await fs.rename(downloadedPath, finalPath)
        onProgress(1)
        return finalPath
      } finally {
        this.currentDownloads.delete(recording.recordingId)
        await fs
          .rm(attemptDir, { recursive: true, force: true })
          .catch(() => {})
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
      if (
        item.mediaRecordingId &&
        item.mediaRecordingId !== item.recording.recordingId
      ) {
        item.status = "error"
        item.error = "This media file belongs to a different recording."
        this.emitItem(item)
        continue
      }
      const duplicateOwner = Object.values(this.getCatalog()).find(
        other =>
          other !== item &&
          other.filePath &&
          path.resolve(other.filePath) === path.resolve(item.filePath!),
      )
      if (duplicateOwner) {
        item.status = "error"
        item.error = `This media file is also assigned to ${duplicateOwner.recording.title}. Download this recording again.`
        this.emitItem(item)
        continue
      }
      item.status = "queued"
      item.error = undefined
      item.progress = undefined
      item.transcriptionStage = undefined
      this.transcriptionQueue.push(recordingId)
      this.emitItem(item)
    }
    await store.write()
    await this.pumpTranscriptionQueue()
  }

  private async pumpTranscriptionQueue(): Promise<void> {
    if (this.pumpingTranscriptions) return
    this.pumpingTranscriptions = true
    try {
      // Loading multiple Whisper models at once can exhaust system memory.
      while (
        this.transcriptionJobs.size === 0 &&
        this.transcriptionQueue.length
      ) {
        const recordingId = this.transcriptionQueue.shift()
        if (!recordingId) continue
        const item = this.getCatalog()[recordingId]
        if (!item?.filePath || item.status !== "queued") continue
        try {
          item.status = "transcribing"
          item.progress = 0
          item.transcriptionStage = "starting"
          await store.write()
          this.emitItem(item)
          const courseFolderName = item.recording.courseName.replace(
            /[/\\?%*:;|"<>]/g,
            "-",
          )
          await transcriberWorker.start({
            recordingId,
            mediaPath: item.filePath,
            sourceUrl: item.recording.webexUrl,
            materialsPath: path.join(
              store.data.settings.downloadPath,
              courseFolderName,
            ),
            outputPath: path.join(
              store.data.settings.transcriberOutputPath,
              courseFolderName,
            ),
            onJobId: id =>
              this.transcriptionJobs.set(id, {
                recordingId,
                mediaPath: item.filePath!,
              }),
          })
        } catch (err) {
          for (const [jobId, job] of Array.from(this.transcriptionJobs)) {
            if (job.recordingId === recordingId) {
              this.transcriptionJobs.delete(jobId)
            }
          }
          item.status = "error"
          item.error = `Could not start transcription: ${String(err)}`
          await store.write()
          this.emitItem(item)
        }
      }
    } finally {
      this.pumpingTranscriptions = false
      if (this.transcriptionJobs.size === 0 && this.transcriptionQueue.length) {
        setImmediate(() => void this.pumpTranscriptionQueue())
      }
    }
  }

  cancelTranscription(recordingId: string): boolean {
    const queuedIndex = this.transcriptionQueue.indexOf(recordingId)
    if (queuedIndex !== -1) {
      this.transcriptionQueue.splice(queuedIndex, 1)
      const item = this.getCatalog()[recordingId]
      if (item) {
        item.status = item.filePath ? "downloaded" : "available"
        item.progress = undefined
        item.transcriptionStage = undefined
        item.error = "Transcription cancelled."
        void store.write()
        this.emitItem(item)
      }
      return true
    }
    const pair = Array.from(this.transcriptionJobs.entries()).find(
      ([, job]) => job.recordingId === recordingId,
    )
    if (!pair) return false
    const cancelled = transcriberWorker.cancel(pair[0])
    if (cancelled) {
      this.transcriptionJobs.delete(pair[0])
      const item = this.getCatalog()[recordingId]
      if (item) {
        item.status = item.filePath ? "downloaded" : "available"
        item.progress = undefined
        item.transcriptionStage = undefined
        item.error = "Transcription cancelled."
        store.write()
        this.emitItem(item)
      }
      void this.pumpTranscriptionQueue()
    }
    return cancelled
  }

  private async handleTranscriberEvent(
    event: TranscriberWorkerEvent,
  ): Promise<void> {
    const job = this.transcriptionJobs.get(event.job_id)
    if (!job) return
    const item = this.getCatalog()[job.recordingId]
    if (!item) return
    const terminal = event.type === "complete" || event.type === "error"
    if (event.type === "progress") {
      item.status = event.stage === "complete" ? "completed" : "transcribing"
      item.progress = event.fraction
      item.transcriptionStage = event.stage
    } else if (event.type === "complete") {
      const artifactMediaPath = event.artifacts?.media_file
      if (
        !artifactMediaPath ||
        path.resolve(artifactMediaPath) !== path.resolve(job.mediaPath)
      ) {
        item.status = "error"
        item.error =
          "Transcriber returned results for a different media file. Nothing was attached to this recording."
        this.transcriptionJobs.delete(event.job_id)
        await store.write()
        this.emitItem(item)
        await this.pumpTranscriptionQueue()
        return
      }
      item.status = "completed"
      item.progress = 1
      item.transcriptionStage = undefined
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
    if (terminal) await this.pumpTranscriptionQueue()
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
