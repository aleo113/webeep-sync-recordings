import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import { EventEmitter } from "events"
import readline from "readline"
import { randomUUID } from "crypto"
import { store, storeIsReady } from "./store"

export interface TranscriberJobRequest {
  recordingId: string
  mediaPath: string
  sourceUrl: string
}

export interface TranscriberDownloadRequest {
  url: string
  outputDir: string
  onJobId?: (jobId: string) => void
}

export interface TranscriberWorkerEvent {
  type: "progress" | "complete" | "error"
  job_id: string
  stage?: string
  fraction?: number
  message?: string
  code?: string
  artifacts?: Record<string, string | null>
}

export class TranscriberWorker extends EventEmitter {
  private jobs = new Map<string, ChildProcessWithoutNullStreams>()

  async start(request: TranscriberJobRequest): Promise<string> {
    await storeIsReady()
    const jobId = randomUUID()
    this.launch(jobId, {
      type: "start",
      job_id: jobId,
      media_path: request.mediaPath,
      source_url: request.sourceUrl,
      lecture_id: request.recordingId,
      workspace_root: store.data.settings.transcriberWorkspacePath,
      output_root: store.data.settings.transcriberOutputPath,
      materials_root: store.data.settings.transcriberMaterialsPath || null,
      whisper_model: store.data.settings.transcriberWhisperModel,
      notes_mode: store.data.settings.transcriberNotesMode,
    })
    return jobId
  }

  async download(request: TranscriberDownloadRequest): Promise<string> {
    await storeIsReady()
    const jobId = randomUUID()
    request.onJobId?.(jobId)
    return new Promise((resolve, reject) => {
      const onEvent = (event: TranscriberWorkerEvent) => {
        if (event.job_id !== jobId) return
        if (event.type === "complete") {
          this.removeListener("event", onEvent)
          const mediaPath = event.artifacts?.media_file
          if (mediaPath) resolve(mediaPath)
          else
            reject(new Error("Transcriber downloader returned no media file."))
        } else if (event.type === "error") {
          this.removeListener("event", onEvent)
          reject(new Error(event.message || event.code || "Download failed."))
        }
      }
      this.on("event", onEvent)
      this.launch(jobId, {
        type: "download",
        job_id: jobId,
        url: request.url,
        output_dir: request.outputDir,
        poliwebex_path: store.data.settings.transcriberPoliwebexPath,
        skip_keyring: false,
      })
    })
  }

  private launch(jobId: string, command: Record<string, unknown>): void {
    const python = store.data.settings.transcriberPythonPath || "python3"
    const child = spawn(python, ["-m", "transcriber.worker"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.jobs.set(jobId, child)

    readline.createInterface({ input: child.stdout }).on("line", line => {
      try {
        const event = JSON.parse(line) as TranscriberWorkerEvent
        this.emit("event", event)
      } catch {
        this.emit("event", {
          type: "error",
          job_id: jobId,
          code: "INVALID_WORKER_OUTPUT",
          message: line,
        } satisfies TranscriberWorkerEvent)
      }
    })

    let stderr = ""
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8000)
    })
    child.on("error", err => {
      this.jobs.delete(jobId)
      this.emit("event", {
        type: "error",
        job_id: jobId,
        code: "WORKER_START_FAILED",
        message: err.message,
      } satisfies TranscriberWorkerEvent)
    })
    child.on("exit", (code, signal) => {
      this.jobs.delete(jobId)
      if (signal || (code && code !== 0)) {
        this.emit("event", {
          type: "error",
          job_id: jobId,
          code: signal ? "CANCELLED" : "WORKER_EXITED",
          message:
            stderr ||
            (signal
              ? "Transcriber worker was cancelled."
              : `Transcriber worker exited with code ${code}`),
        } satisfies TranscriberWorkerEvent)
      }
    })

    child.stdin.end(`${JSON.stringify(command)}\n`)
  }

  cancel(jobId: string): boolean {
    const child = this.jobs.get(jobId)
    if (!child) return false
    child.kill("SIGTERM")
    this.jobs.delete(jobId)
    return true
  }
}

export const transcriberWorker = new TranscriberWorker()
