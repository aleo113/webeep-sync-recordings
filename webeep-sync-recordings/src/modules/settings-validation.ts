import type { Settings } from "./store"

export const settingLimits = {
  maxConcurrentDownloads: [1, 100],
  recordingsSyncInterval: [5, 1440],
  recordingsMaxConcurrent: [1, 5],
  transcriberWhisperNumCores: [1, 64],
} as const

const booleanKeys = [
  "syncNewCourses",
  "keepOpenInBackground",
  "trayIcon",
  "automaticUpdates",
  "openAtLogin",
  "notificationOnNewFiles",
  "notificationOnMessage",
  "recordingsEnabled",
  "recordingsAutoDownload",
  "recordingsAutoTranscribe",
  "recordingsStartCollapsed",
]
const pathKeys = [
  "recordingsDownloadPath",
  "transcriberWorkspacePath",
  "transcriberOutputPath",
  "transcriberPythonPath",
  "transcriberPoliwebexPath",
  "transcriberMaterialsPath",
]
const choices: Record<string, readonly string[]> = {
  language: ["it", "en"],
  nativeThemeSource: ["system", "light", "dark"],
  transcriberWhisperModel: [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "turbo",
  ],
  transcriberNotesProvider: ["codex", "claude", "antigravity"],
  transcriberNotesMode: ["transcript-only", "prompt-pack", "api"],
}

export function validateSettingsUpdate(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid settings.")
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(settingLimits, key)) {
      const [min, max] = settingLimits[key as keyof typeof settingLimits]
      if (
        typeof entry !== "number" ||
        !Number.isInteger(entry) ||
        entry < min ||
        entry > max
      )
        throw new Error(
          `${key}: enter a whole number between ${min} and ${max}.`,
        )
    } else if (booleanKeys.includes(key)) {
      if (typeof entry !== "boolean")
        throw new Error(`${key}: expected a boolean.`)
    } else if (
      [
        "transcriberCodexModel",
        "transcriberClaudeModel",
        "transcriberAntigravityModel",
      ].includes(key)
    ) {
      if (
        typeof entry !== "string" ||
        entry.includes("\0") ||
        entry.length > 256
      )
        throw new Error(`${key}: invalid model name.`)
    } else if (pathKeys.includes(key)) {
      if (typeof entry !== "string" || entry.includes("\0"))
        throw new Error(`${key}: invalid path.`)
      if (
        [
          "recordingsDownloadPath",
          "transcriberWorkspacePath",
          "transcriberOutputPath",
        ].includes(key) &&
        !entry.trim()
      )
        throw new Error(`${key}: choose a folder.`)
    } else if (Object.prototype.hasOwnProperty.call(choices, key)) {
      if (typeof entry !== "string" || !choices[key].includes(entry))
        throw new Error(`${key}: invalid choice.`)
    } else {
      throw new Error(`Unknown setting: ${key}`)
    }
    result[key] = entry
  }
  return result as Settings
}
