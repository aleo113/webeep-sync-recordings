import { platform } from "os"
import { ipcRenderer } from "electron"
import React, { FC, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { IoWarning, IoFolderOpen } from "react-icons/io5"
import {
  validateSettingsUpdate,
  settingLimits,
} from "../../modules/settings-validation"
import { Settings } from "../../modules/store"
import { Modal } from "../components/Modal"
import { Link } from "../components/Link"
import { Switch } from "../components/Switch"
import PolinetworkLogo from "../assets/polinetwork.svg"

const tabs = ["general", "recordings", "transcriber", "about"] as const
type Theme = "light" | "dark" | "system"

export const SettingsModal: FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation("client", { keyPrefix: "settings" })
  const [settings, setSettings] = useState<Settings>()
  const [tab, setTab] = useState<(typeof tabs)[number]>("general")
  const [version, setVersion] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const savedTheme = useRef<Theme>()
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    Promise.all([
      ipcRenderer.invoke("settings"),
      ipcRenderer.invoke("get-native-theme"),
      ipcRenderer.invoke("version"),
    ])
      .then(([value, theme, appVersion]) => {
        if (!alive.current) return
        setSettings(value)
        savedTheme.current = theme
        setVersion(appVersion)
      })
      .catch(err => setError(String(err)))
    return () => {
      alive.current = false
      if (savedTheme.current)
        ipcRenderer.send("set-native-theme", savedTheme.current)
    }
  }, [])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings(previous => ({ ...previous, [key]: value }))

  const toggle = (
    key: keyof Settings,
    description?: string,
    disabled = false,
    label: string = key,
  ) => (
    <div className={`setting ${disabled ? "disabled" : ""}`} key={key}>
      <label htmlFor={`setting-${key}`}>{t(label)}</label>
      <Switch
        id={`setting-${key}`}
        checked={Boolean(settings[key])}
        disabled={disabled}
        onChange={value => update(key, value)}
      />
      {description && <span className="desc">{t(description)}</span>}
    </div>
  )
  const number = (
    key: keyof Settings,
    min: number,
    max: number,
    label: string = key,
  ) => (
    <div className="setting" key={key}>
      <label htmlFor={`setting-${key}`}>{t(label)}</label>
      <input
        id={`setting-${key}`}
        type="number"
        min={min}
        max={max}
        step={1}
        required
        value={numbers[key] ?? String(settings[key] ?? min)}
        onChange={event => {
          const value = event.target.value
          setNumbers(previous => ({ ...previous, [key]: value }))
          if (value !== "" && Number.isFinite(Number(value)))
            update(key, Number(value))
        }}
      />
      <span className="desc">{t(`${label}_desc`)}</span>
    </div>
  )
  const folder = (key: keyof Settings, label: string = key) => (
    <div className="setting folder-setting" key={key}>
      <label htmlFor={`setting-${key}`}>{t(label)}</label>
      <div className="folder-input">
        <input
          id={`setting-${key}`}
          type="text"
          required
          value={String(settings[key] || "")}
          onChange={event => update(key, event.target.value)}
        />
        <button
          type="button"
          className="text-button"
          aria-label={t("browseFolder")}
          title={t("browseFolder")}
          onClick={async () => {
            try {
              const path = await ipcRenderer.invoke("settings:select-folder")
              if (path) update(key, path)
            } catch (err) {
              setError(String(err))
            }
          }}
        >
          <IoFolderOpen />
        </button>
      </div>
    </div>
  )

  return (
    <Modal
      title={t("settings")}
      onClose={() => {
        if (!saving) onClose()
      }}
    >
      <form
        noValidate
        className="settings"
        onSubmit={async event => {
          event.preventDefault()
          if (!settings || saving) return
          setSaving(true)
          setError("")
          try {
            for (const [key, raw] of Object.entries(numbers)) {
              const [min, max] =
                settingLimits[key as keyof typeof settingLimits]
              if (
                !raw.trim() ||
                !Number.isInteger(Number(raw)) ||
                Number(raw) < min ||
                Number(raw) > max
              ) {
                setTab(
                  key === "maxConcurrentDownloads"
                    ? "general"
                    : key === "transcriberWhisperNumCores"
                      ? "transcriber"
                      : "recordings",
                )
                throw new Error(t("invalidNumber", { min, max }))
              }
            }
            await ipcRenderer.invoke(
              "set-settings",
              validateSettingsUpdate(settings),
            )
            savedTheme.current = settings.nativeThemeSource
            onClose()
          } catch (err) {
            setError(String(err))
            setSaving(false)
          }
        }}
      >
        <nav className="settings-nav" aria-label={t("sections")}>
          {tabs.map(item => (
            <button
              type="button"
              key={item}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {t(`tabs.${item}`)}
            </button>
          ))}
        </nav>
        {error && (
          <div className="settings-error" role="alert">
            {error}
          </div>
        )}
        {!settings ? (
          <p role="status">{error ? t("loadFailed") : t("loading")}</p>
        ) : (
          <fieldset disabled={saving} className="settings-content">
            <div hidden={tab !== "general"}>
              <div className="setting-section">
                <h3>{t("appearance")}</h3>
                <div className="setting">
                  <label htmlFor="setting-theme">{t("colorTheme")}</label>
                  <select
                    id="setting-theme"
                    value={settings.nativeThemeSource}
                    onChange={event => {
                      const theme = event.target.value as Theme
                      ipcRenderer.send("set-native-theme", theme)
                      update("nativeThemeSource", theme)
                    }}
                  >
                    {["system", "light", "dark"].map(theme => (
                      <option key={theme} value={theme}>
                        {t(`theme.${theme}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setting">
                  <label htmlFor="setting-language">{t("language")}</label>
                  <select
                    id="setting-language"
                    value={settings.language}
                    onChange={event =>
                      update("language", event.target.value as "it" | "en")
                    }
                  >
                    <option value="it">Italiano</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>
              <div className="setting-section">
                <h3>{t("background")}</h3>
                {platform() !== "linux" && (
                  <>
                    {toggle("automaticUpdates", "automaticUpdates_desc")}
                    {toggle("openAtLogin")}
                  </>
                )}
                {toggle("keepOpenInBackground", "keepOpenInBackground_desc")}
                {toggle(
                  "trayIcon",
                  undefined,
                  !settings.keepOpenInBackground,
                  "showInTray",
                )}
                {settings.keepOpenInBackground && !settings.trayIcon && (
                  <div className="setting-warn">
                    <IoWarning />
                    <span>{t("trayWarning")}</span>
                  </div>
                )}
                {toggle(
                  "notificationOnNewFiles",
                  undefined,
                  !settings.keepOpenInBackground,
                  "notifications",
                )}
                {toggle(
                  "notificationOnMessage",
                  undefined,
                  !settings.keepOpenInBackground,
                  "msgNotifications",
                )}
              </div>
              <div className="setting-section">
                <h3>{t("courseFiles")}</h3>
                {toggle(
                  "syncNewCourses",
                  "newCourses_desc",
                  false,
                  "newCourses",
                )}
                {number(
                  "maxConcurrentDownloads",
                  1,
                  100,
                  "concurrentDownloads",
                )}
              </div>
            </div>
            <div hidden={tab !== "recordings"}>
              <div className="setting-section">
                <h3>{t("discovery")}</h3>
                {toggle("recordingsEnabled", "recordingsEnabled_desc")}
                <fieldset disabled={!settings.recordingsEnabled}>
                  {number("recordingsSyncInterval", 5, 1440)}
                </fieldset>
                <p className="section-description">{t("discoveryHelp")}</p>
              </div>
              <div className="setting-section">
                <h3>{t("downloads")}</h3>
                {folder("recordingsDownloadPath")}
                {number("recordingsMaxConcurrent", 1, 5)}
                {toggle(
                  "recordingsAutoDownload",
                  "recordingsAutoDownload_desc",
                  !settings.recordingsEnabled,
                )}
                {toggle(
                  "recordingsAutoTranscribe",
                  "recordingsAutoTranscribe_desc",
                  !settings.recordingsEnabled ||
                    !settings.recordingsAutoDownload,
                )}
              </div>
              <div className="setting-section">
                <h3>{t("display")}</h3>
                {toggle(
                  "recordingsStartCollapsed",
                  "recordingsStartCollapsed_desc",
                )}
              </div>
            </div>
            <div hidden={tab !== "transcriber"}>
              <div className="setting-section">
                <h3>{t("transcriberSection")}</h3>
                {folder("transcriberOutputPath")}
                <div className="setting">
                  <label htmlFor="setting-model">
                    {t("transcriberWhisperModel")}
                  </label>
                  <select
                    id="setting-model"
                    value={settings.transcriberWhisperModel}
                    onChange={event =>
                      update("transcriberWhisperModel", event.target.value)
                    }
                  >
                    {[
                      "tiny",
                      "base",
                      "small",
                      "medium",
                      "large-v3",
                      "turbo",
                    ].map(model => (
                      <option key={model}>{model}</option>
                    ))}
                  </select>
                  <span className="desc">
                    {t("transcriberWhisperModel_desc")}
                  </span>
                </div>
                {number("transcriberWhisperNumCores", 1, 64)}
                <div className="setting">
                  <label htmlFor="setting-output-mode">
                    {t("transcriberNotesMode")}
                  </label>
                  <select
                    id="setting-output-mode"
                    value={settings.transcriberNotesMode}
                    onChange={event =>
                      update(
                        "transcriberNotesMode",
                        event.target.value as Settings["transcriberNotesMode"],
                      )
                    }
                  >
                    <option value="transcript-only">
                      {t("transcriptOnly")}
                    </option>
                    <option value="prompt-pack">{t("promptPack")}</option>
                    <option value="api">{t("generatedNotes")}</option>
                  </select>
                  <span className="desc">{t("notesModeHelp")}</span>
                </div>
                {settings.transcriberNotesMode === "api" && (
                  <>
                    <div className="setting">
                      <label htmlFor="setting-notes-provider">
                        {t("transcriberNotesProvider")}
                      </label>
                      <select
                        id="setting-notes-provider"
                        value={settings.transcriberNotesProvider || "codex"}
                        onChange={event =>
                          update(
                            "transcriberNotesProvider",
                            event.target.value as "codex" | "claude",
                          )
                        }
                      >
                        <option value="codex">Codex (ChatGPT)</option>
                        <option value="claude">Claude</option>
                      </select>
                      <span className="desc">
                        {t("transcriberNotesProvider_desc")}
                      </span>
                    </div>
                    <div className="setting">
                      <label htmlFor="setting-notes-model">
                        {t("transcriberNotesModel")}
                      </label>
                      <input
                        id="setting-notes-model"
                        type="text"
                        value={
                          (settings.transcriberNotesProvider === "claude"
                            ? settings.transcriberClaudeModel
                            : settings.transcriberCodexModel) || ""
                        }
                        placeholder={
                          settings.transcriberNotesProvider === "claude"
                            ? "sonnet"
                            : "gpt-5.6-luna"
                        }
                        onChange={event =>
                          update(
                            settings.transcriberNotesProvider === "claude"
                              ? "transcriberClaudeModel"
                              : "transcriberCodexModel",
                            event.target.value,
                          )
                        }
                      />
                      <span className="desc">
                        {t("transcriberNotesModel_desc")}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <details className="setting-section">
                <summary>{t("advanced")}</summary>
                <p className="section-description">{t("advancedHelp")}</p>
                {folder("transcriberWorkspacePath")}
                {folder("transcriberPoliwebexPath")}
                <div className="setting folder-setting">
                  <label htmlFor="setting-python">
                    {t("transcriberPythonPath")}
                  </label>
                  <input
                    id="setting-python"
                    value={settings.transcriberPythonPath || ""}
                    onChange={event =>
                      update("transcriberPythonPath", event.target.value)
                    }
                  />
                </div>
              </details>
            </div>
            <div hidden={tab !== "about"}>
              <div className="setting-section settings-about">
                <h3>WeBeep Sync Recordings</h3>
                <p>v{version}</p>
                <p>{t("aboutDescription")}</p>
                <span className="credits">
                  Developed by Tommaso Morganti •{" "}
                  <Link href="https://github.com/toto04/webeep-sync">
                    WeBeep Sync
                  </Link>
                  <br />
                  <Link href="https://polinetwork.org">
                    <PolinetworkLogo fill="#888" height={32} width={32} />
                    <br />
                    Powered by PoliNetwork
                  </Link>
                </span>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => ipcRenderer.send("logout")}
                >
                  {t("logout")}
                </button>
              </div>
            </div>
          </fieldset>
        )}
        <div className="settings-footer">
          <button
            type="button"
            className="discard-button"
            disabled={saving}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="confirm-button"
            disabled={!settings || saving}
          >
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </form>
    </Modal>
  )
}
