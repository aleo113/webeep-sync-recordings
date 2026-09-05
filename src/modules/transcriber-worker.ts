import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import { EventEmitter } from "events"
import readline from "readline"
import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import { app } from "electron"
import { store, storeIsReady } from "./store"
import { SPIDCredentials } from "./recordings-types"

export interface TranscriberJobRequest {
  recordingId: string
  mediaPath: string
  sourceUrl: string
  materialsPath: string
  outputPath: string
  onJobId?: (jobId: string) => void
}

export interface TranscriberDownloadRequest {
  url: string
  outputDir: string
  spidCredentials?: SPIDCredentials | null
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
    request.onJobId?.(jobId)
    this.launch(jobId, {
      type: "start",
      job_id: jobId,
      media_path: request.mediaPath,
      source_url: request.sourceUrl,
      lecture_id: request.recordingId,
      workspace_root: store.data.settings.transcriberWorkspacePath,
      output_root: request.outputPath,
      materials_root: request.materialsPath,
      whisper_model: store.data.settings.transcriberWhisperModel,
      whisper_num_cores: store.data.settings.transcriberWhisperNumCores,
      notes_mode: store.data.settings.transcriberNotesMode,
      notes_provider: store.data.settings.transcriberNotesProvider,
      // A cleared model field must not reach the worker as "": undefined keys
      // are dropped by JSON.stringify and the worker falls back to its default.
      codex_model:
        store.data.settings.transcriberCodexModel?.trim() || undefined,
      claude_model:
        store.data.settings.transcriberClaudeModel?.trim() || undefined,
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
      const bundledPoliwebex = this.runtimePath("PoliWebex")
      this.launch(jobId, {
        type: "download",
        job_id: jobId,
        url: request.url,
        output_dir: request.outputDir,
        poliwebex_path: fs.existsSync(bundledPoliwebex)
          ? bundledPoliwebex
          : store.data.settings.transcriberPoliwebexPath,
        skip_keyring: false,
        // PoliWebex prompts on stdin (a closed pipe here) when it has no
        // saved credentials: forward the ones stored in the app instead.
        spid_username: request.spidCredentials?.username || undefined,
        spid_password: request.spidCredentials?.password || undefined,
        polimi_email: request.spidCredentials?.polimiEmail || undefined,
      })
    })
  }

  private launch(jobId: string, command: Record<string, unknown>): void {
    const bundledWorker = this.runtimePath(
      process.platform === "win32"
        ? "bin/transcriber-worker.exe"
        : "bin/transcriber-worker",
    )
    const developmentPython = this.runtimePath(
      process.platform === "win32"
        ? ".venv/Scripts/python.exe"
        : ".venv/bin/python",
    )
    const executable = fs.existsSync(bundledWorker)
      ? bundledWorker
      : fs.existsSync(developmentPython)
        ? developmentPython
        : store.data.settings.transcriberPythonPath || "python3"
    const args =
      executable === bundledWorker ? [] : ["-m", "transcriber.worker"]
    const child = spawn(executable, args, {
      env: this.workerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.jobs.set(jobId, child)
    let terminalEventReceived = false

    readline.createInterface({ input: child.stdout }).on("line", line => {
      try {
        const event = JSON.parse(line) as TranscriberWorkerEvent
        if (event.type === "complete" || event.type === "error") {
          terminalEventReceived = true
        }
        this.emit("event", event)
      } catch {
        terminalEventReceived = true
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
      terminalEventReceived = true
      this.emit("event", {
        type: "error",
        job_id: jobId,
        code: "WORKER_START_FAILED",
        message: err.message,
      } satisfies TranscriberWorkerEvent)
    })
    child.on("close", (code, signal) => {
      this.jobs.delete(jobId)
      if (!terminalEventReceived) {
        this.emit("event", {
          type: "error",
          job_id: jobId,
          code: signal === "SIGTERM" ? "CANCELLED" : "WORKER_EXITED",
          // Cancellation must win over stderr: Python always emits harmless
          // import warnings there, which used to mask the real close reason.
          message:
            signal === "SIGTERM"
              ? "Transcriber worker was cancelled."
              : stderr ||
                `Transcriber worker exited without returning a result (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}).`,
        } satisfies TranscriberWorkerEvent)
      }
    })

    child.stdin.end(`${JSON.stringify(command)}\n`)
  }

  private workerEnv(): NodeJS.ProcessEnv {
    if (process.platform !== "darwin") return process.env
    // GUI-launched macOS apps get a minimal PATH without Homebrew or nvm, so
    // the worker (and PoliWebex under it) would not find ffmpeg/aria2c/node.
    const env: NodeJS.ProcessEnv = { ...process.env }
    const extraPaths: string[] = []
    // The nvm node dir must come before /usr/local/bin, where a stale
    // .pkg-installed node would otherwise shadow it.
    const nvmNode = this.latestNvmNodeBinDir()
    if (nvmNode) extraPaths.push(nvmNode)
    extraPaths.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      // claude/codex CLI default install locations
      path.join(app.getPath("home"), ".local", "bin"),
    )
    env.PATH = [env.PATH, ...extraPaths].filter(Boolean).join(":")
    // A stale Hugging Face token in ~/.cache/huggingface makes even public
    // Whisper model downloads fail with 401; the models we pull are public.
    if (env.HF_HUB_DISABLE_IMPLICIT_TOKEN === undefined) {
      env.HF_HUB_DISABLE_IMPLICIT_TOKEN = "1"
    }
    return env
  }

  private latestNvmNodeBinDir(): string | null {
    const versionsDir = path.join(
      app.getPath("home"),
      ".nvm",
      "versions",
      "node",
    )
    try {
      const versions = fs
        .readdirSync(versionsDir)
        .filter(v => /^v\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => {
          const pa = a.slice(1).split(".").map(Number)
          const pb = b.slice(1).split(".").map(Number)
          return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
        })
      const latest = versions.at(-1)
      return latest ? path.join(versionsDir, latest, "bin") : null
    } catch {
      return null
    }
  }

  private runtimePath(relativePath: string): string {
    const root = app.isPackaged
      ? path.join(process.resourcesPath, "transcriber")
      : path.resolve(app.getAppPath(), "../Transcriber")
    return path.join(root, relativePath)
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
