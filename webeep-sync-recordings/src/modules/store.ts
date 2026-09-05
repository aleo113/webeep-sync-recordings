import path from "path"
import fs from "fs/promises"
import { nativeTheme, app } from "electron"
import { EventEmitter } from "events"
/* eslint-disable import/no-unresolved */
// for some reason, eslint complains about lowdb and i dont know how to fix it
import { Low } from "lowdb"
import { JSONFile } from "lowdb/node"
/* eslint-enable import/no-unresolved */

import { createLogger } from "./logger"
import { RecordingCatalogItem } from "./recordings-types"
const { log } = createLogger("Store")

/***
 * store.json manifest version, to be increased when breaking changes are made so that a correct
 * fixes for the change can be implemented in the {@link updateManifestVersion} function
 */
const CURRENT_MANIFEST_VERSION = 6

/**
 * Check in the Settings page in the app for detailed explanation of what each setting does
 */
export interface Settings {
  syncNewCourses?: boolean
  downloadPath?: string
  autosyncEnabled?: boolean
  autosyncInterval?: number
  nativeThemeSource?: typeof nativeTheme.themeSource
  keepOpenInBackground?: boolean
  trayIcon?: boolean
  automaticUpdates?: boolean
  openAtLogin?: boolean
  language?: "it" | "en"
  notificationOnNewFiles?: boolean
  notificationOnMessage?: boolean
  maxConcurrentDownloads?: number
  recordingsEnabled?: boolean
  recordingsSyncInterval?: number
  recordingsDownloadPath?: string
  recordingsMaxConcurrent?: number
  recordingsAutoDownload?: boolean
  recordingsAutoTranscribe?: boolean
  recordingsStartCollapsed?: boolean
  transcriberPythonPath?: string
  transcriberPoliwebexPath?: string
  transcriberWorkspacePath?: string
  transcriberOutputPath?: string
  transcriberMaterialsPath?: string
  transcriberWhisperModel?: string
  transcriberWhisperNumCores?: number
  transcriberNotesMode?: "transcript-only" | "prompt-pack" | "api"
  transcriberNotesProvider?: "codex" | "claude"
  transcriberCodexModel?: string
  transcriberClaudeModel?: string
}

export interface Persistence {
  courses: {
    [courseid: number]: {
      name: string
      shouldSync: boolean
      archiveUrl?: string
    }
  }
  sentMessageNotifications: Record<string, { sentTimestamp: number }>
  lastSynced?: number
  /**
   * whether or not a notification has already been sent to the user
   */
  notificationsHasBeenSent?: boolean
  downloadedRecordings?: Record<
    string,
    {
      webexUrl: string
      title: string
      courseId: number
      downloadedAt: number
      filePath: string
    }
  >
  recordingsLastChecked?: number
  recordingCatalog?: Record<string, RecordingCatalogItem>
  recordingDiscoveryState?: {
    modules: Record<
      string,
      {
        sourceUrl: string
        resolvedUrl: string
        kind: "webex" | "archive" | "unsupported"
        checkedAt?: number
      }
    >
    archives: Record<
      string,
      {
        knownCandidateUrls: string[]
        lastFullCheckedAt?: number
      }
    >
  }
  spidCredentials?: string
}

export interface Store {
  manifestVersion?: number
  settings: Settings
  persistence: Persistence
}

export const defaultSettings: Required<Settings> = {
  syncNewCourses: true,
  downloadPath: path.join(app.getPath("documents"), "/WeBeep Sync/"),
  autosyncEnabled: true,
  autosyncInterval: 2 * 60 * 60 * 1000, // 2 hours
  nativeThemeSource: "system",
  keepOpenInBackground: true,
  trayIcon: true,
  automaticUpdates: true,
  openAtLogin: false,
  language: app.getLocaleCountryCode() === "IT" ? "it" : "en",
  notificationOnNewFiles: true,
  notificationOnMessage: true,
  maxConcurrentDownloads: 5,
  recordingsEnabled: true,
  recordingsSyncInterval: 30, // minutes
  recordingsDownloadPath: path.join(
    app.getPath("documents"),
    "/WeBeep Sync/Recordings/",
  ),
  recordingsMaxConcurrent: 1,
  recordingsAutoDownload: false,
  recordingsAutoTranscribe: false,
  recordingsStartCollapsed: true,
  transcriberPythonPath: "python3",
  transcriberPoliwebexPath:
    process.env.POLIWEBEX_PATH ||
    path.resolve(app.getAppPath(), "../Transcriber/PoliWebex"),
  transcriberWorkspacePath: path.join(app.getPath("userData"), "transcriber"),
  transcriberOutputPath: path.join(app.getPath("documents"), "WeBeep Notes"),
  transcriberMaterialsPath: "",
  transcriberWhisperModel: "small",
  transcriberWhisperNumCores: 2,
  transcriberNotesMode: "transcript-only",
  transcriberNotesProvider: "codex",
  transcriberCodexModel: "gpt-5.6-luna",
  transcriberClaudeModel: "sonnet",
}

const storePath = path.join(app.getPath("userData"), "store.json")
export const store = new Low<Store>(new JSONFile(storePath), {
  settings: {},
  persistence: {
    courses: {},
    sentMessageNotifications: {},
  },
})

let initialized = false
let initializing = false

const storeInitializationEE = new EventEmitter()

/**
 * this function checks (and eventually restores) the correct shape of the store.data object to
 * to ensure correct functionality
 * TODO: do things recursively so that adhoc changes dont have to be implemented by hand
 */
function checkStoreIntegrity() {
  if (!store.data)
    store.data = {
      settings: {},
      persistence: {
        courses: {},
        sentMessageNotifications: {},
        downloadedRecordings: {},
        recordingDiscoveryState: { modules: {}, archives: {} },
      },
    }
  if (!store.data.persistence) {
    store.data.persistence = {
      courses: {},
      sentMessageNotifications: {},
      downloadedRecordings: {},
      recordingDiscoveryState: { modules: {}, archives: {} },
    }
  } else {
    if (!store.data.persistence.courses) store.data.persistence.courses = {}
    if (!store.data.persistence.sentMessageNotifications)
      store.data.persistence.sentMessageNotifications = {}
    if (!store.data.persistence.downloadedRecordings)
      store.data.persistence.downloadedRecordings = {}
    if (!store.data.persistence.recordingCatalog)
      store.data.persistence.recordingCatalog = {}
    if (!store.data.persistence.recordingDiscoveryState) {
      store.data.persistence.recordingDiscoveryState = {
        modules: {},
        archives: {},
      }
    }

    for (const id in store.data.persistence.courses) {
      // for retrocompatibility, if the shape is not right reset the whole object
      if (
        store.data.persistence.courses[id].name === undefined ||
        store.data.persistence.courses[id].shouldSync === undefined
      ) {
        store.data.persistence.courses = {}
        break
      }
    }
  }
}

/**
 * this function checks the manifest version, if lower than the {@link CURRENT_MANIFEST_VERSION}
 * then corrections should be made to make sure that everything works after an update
 * @returns
 */
async function updateManifestVersion() {
  const ver = store.data.manifestVersion ?? 0
  if (ver === CURRENT_MANIFEST_VERSION) return
  log(
    `applying fixes for outdated manifest version: ${ver} / ${CURRENT_MANIFEST_VERSION}`,
  )

  // add here checks to mutate from old version
  if (ver < 2) {
    // this fixes leading/trailing whitespaces in folders which causes all sorts of wierd bugs
    for (const id in store.data.persistence.courses) {
      try {
        const trimmed = store.data.persistence.courses[id].name.trim()
        if (trimmed !== store.data.persistence.courses[id].name) {
          const oldPath = path.resolve(
            store.data.settings.downloadPath,
            store.data.persistence.courses[id].name,
          )
          const newPath = path.resolve(
            store.data.settings.downloadPath,
            trimmed,
          )
          store.data.persistence.courses[id].name = trimmed
          log(`Trimmed course ${id} folder: ${trimmed}`)
          await fs.rename(oldPath, newPath)
        }
      } catch (e) {
        log(`ignoring error while trimming course ${id}`)
      }
    }
  }

  if (ver < 3) {
    // initialize new recordings persistence fields
    store.data.persistence.downloadedRecordings = {}
    store.data.persistence.recordingsLastChecked = 0
    store.data.persistence.spidCredentials = undefined
  }
  if (ver < 4) {
    delete (store.data.settings as Record<string, unknown>).notesProviderApiKey
    delete (store.data.settings as Record<string, unknown>).notesProvider
    delete (store.data.settings as Record<string, unknown>).notesModel
  }
  if (ver < 5) {
    const transcriberRoot = path.resolve(app.getAppPath(), "../Transcriber")
    const localPython = path.join(transcriberRoot, ".venv", "bin", "python")
    try {
      await fs.access(localPython)
      if (
        !store.data.settings.transcriberPythonPath ||
        store.data.settings.transcriberPythonPath === "python3"
      ) {
        store.data.settings.transcriberPythonPath = localPython
      }
    } catch {
      // Keep the configured/system Python when the sibling development venv is absent.
    }
    if (!store.data.settings.transcriberPoliwebexPath) {
      store.data.settings.transcriberPoliwebexPath = path.join(
        transcriberRoot,
        "PoliWebex",
      )
    }
  }
  if (ver < 6) {
    for (const course of Object.values(store.data.persistence.courses)) {
      if (course.archiveUrl) delete course.archiveUrl
    }
  }

  // once sure that everything is updated, change the manifest version
  store.data.manifestVersion = CURRENT_MANIFEST_VERSION
  log(`manifest version updated! (now ${CURRENT_MANIFEST_VERSION})`)
}

export async function storeIsReady(): Promise<void> {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    if (initialized) {
      resolve()
      return
    }
    if (initializing) {
      storeInitializationEE.on("ready", () => resolve())
      return
    }

    initializing = true

    await store.read()
    checkStoreIntegrity()

    // assign default settings if missing
    store.data.settings = Object.assign(
      {},
      defaultSettings,
      store.data.settings,
    )
    await updateManifestVersion()

    await store.write()

    initialized = true
    storeInitializationEE.emit("ready")
    log("Store initialized!")
  })
}
storeIsReady()
