import { platform } from "os"
import { ipcRenderer } from "electron"
import React, { FC, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  IoWarning,
  IoMail,
  IoLockClosed,
  IoEye,
  IoEyeOff,
} from "react-icons/io5"
import { Settings } from "../../modules/store"
import { Modal } from "../components/Modal"
import { Link } from "../components/Link"

import PolinetworkLogo from "../assets/polinetwork.svg"
import { Switch } from "../components/Switch"

const themes = ["light", "dark", "system"] as const
type Theme = (typeof themes)[number]

const isLinux = platform() === "linux"

let prevTheme: Theme // the previous theme is stored in case the users cancel the settigns change
export const SettingsModal: FC<{ onClose: () => void }> = props => {
  const { t } = useTranslation("client", { keyPrefix: "settings" })

  const [settings, updateSettigns] =
    useState<
      Omit<Settings, "autosyncEnabled" | "downloadPath" | "autosyncInterval">
    >()
  const [theme, setTheme] = useState<Theme>("system")
  const [version, setVersion] = useState("")

  useEffect(() => {
    ipcRenderer.invoke("settings").then(s => updateSettigns(s))
    ipcRenderer.invoke("get-native-theme").then(t => {
      setTheme(t)
      prevTheme = t
    })
    ipcRenderer.invoke("version").then(v => setVersion(v))
  }, [])

  return (
    <Modal title={t("settings")} onClose={() => props.onClose()}>
      {settings ? (
        <div className="settings">
          <div className="setting-section">
            {theme ? (
              <div className="setting">
                <span>{t("colorTheme")}</span>
                <select
                  value={theme}
                  onChange={e => {
                    const theme = e.target.value as Theme
                    ipcRenderer.send("set-native-theme", theme)
                    setTheme(theme)
                    updateSettigns({ ...settings, nativeThemeSource: theme })
                  }}
                >
                  <option value="system">{t("theme.system")}</option>
                  <option value="light">{t("theme.light")}</option>
                  <option value="dark">{t("theme.dark")}</option>
                </select>
              </div>
            ) : undefined}

            <div className="setting">
              <span>{t("language")}</span>
              <select
                value={settings.language}
                onChange={e => {
                  const language = e.target.value as "it" | "en"
                  updateSettigns({ ...settings, language })
                }}
              >
                <option value="it">Italiano</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>

          <div className="setting-section">
            {isLinux ? undefined : (
              <>
                <div className="setting">
                  <span>{t("automaticUpdates")}</span>
                  <Switch
                    onChange={v =>
                      updateSettigns({ ...settings, automaticUpdates: v })
                    }
                    checked={settings.automaticUpdates}
                  />
                  <span className="desc">{t("automaticUpdates_desc")}</span>
                </div>

                <div className="setting">
                  <span>{t("openAtLogin")}</span>
                  <Switch
                    onChange={v =>
                      updateSettigns({ ...settings, openAtLogin: v })
                    }
                    checked={settings.openAtLogin}
                  />
                </div>
              </>
            )}

            <div className="setting">
              <span>{t("keepOpenInBackground")}</span>
              <Switch
                onChange={v =>
                  updateSettigns({ ...settings, keepOpenInBackground: v })
                }
                checked={settings.keepOpenInBackground}
              />
              <span className="desc">{t("keepOpenInBackground_desc")}</span>
            </div>

            <div
              className={`setting ${
                settings.keepOpenInBackground ? "" : "disabled"
              }`}
            >
              <span>{t("showInTray")}</span>
              <Switch
                disabled={!settings.keepOpenInBackground}
                onChange={v => updateSettigns({ ...settings, trayIcon: v })}
                checked={settings.keepOpenInBackground && settings.trayIcon}
              />
            </div>

            {settings.keepOpenInBackground && !settings.trayIcon ? (
              <div className="setting-warn">
                <IoWarning />
                <span>{t("trayWarning")}</span>
              </div>
            ) : undefined}
          </div>

          <div className="setting-section">
            <div
              className={`setting ${
                settings.keepOpenInBackground ? "" : "disabled"
              }`}
            >
              <span>{t("notifications")}</span>
              <Switch
                disabled={!settings.keepOpenInBackground}
                onChange={v =>
                  updateSettigns({ ...settings, notificationOnNewFiles: v })
                }
                checked={
                  settings.keepOpenInBackground &&
                  settings.notificationOnNewFiles
                }
              />
            </div>

            <div
              className={`setting ${
                settings.keepOpenInBackground ? "" : "disabled"
              }`}
            >
              <span>{t("msgNotifications")}</span>
              <Switch
                disabled={!settings.keepOpenInBackground}
                onChange={v =>
                  updateSettigns({ ...settings, notificationOnMessage: v })
                }
                checked={
                  settings.keepOpenInBackground &&
                  settings.notificationOnMessage
                }
              />
            </div>
          </div>

          <div className="setting-section">
            <div className="setting">
              <span>{t("newCourses")}</span>
              <Switch
                onChange={v =>
                  updateSettigns({ ...settings, syncNewCourses: v })
                }
                checked={settings.syncNewCourses}
              />
              <span className="desc">{t("newCourses_desc")}</span>
            </div>
            <div className="setting">
              <span>{t("concurrentDownloads")}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={settings.maxConcurrentDownloads}
                onChange={e => {
                  let maxConcurrentDownloads = parseInt(e.target.value)
                  if (maxConcurrentDownloads > 100) maxConcurrentDownloads = 100
                  updateSettigns({ ...settings, maxConcurrentDownloads })
                }}
              />
              <span className="desc">{t("concurrentDownloads_desc")}</span>
            </div>
          </div>

          <div className="setting-section">
            <h3>{t("recordingsSection")}</h3>
            <div className="setting">
              <span>{t("recordingsEnabled")}</span>
              <Switch
                onChange={v =>
                  updateSettigns({ ...settings, recordingsEnabled: v })
                }
                checked={settings.recordingsEnabled}
              />
              <span className="desc">{t("recordingsEnabled_desc")}</span>
            </div>
            <div
              className={`setting ${settings.recordingsEnabled ? "" : "disabled"}`}
            >
              <span>{t("recordingsSyncInterval")}</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={settings.recordingsSyncInterval}
                onChange={e => {
                  let interval = parseInt(e.target.value)
                  if (interval < 5) interval = 5
                  if (interval > 1440) interval = 1440
                  updateSettigns({
                    ...settings,
                    recordingsSyncInterval: interval,
                  })
                }}
              />
              <span className="desc">{t("recordingsSyncInterval_desc")}</span>
            </div>
            <div
              className={`setting ${settings.recordingsEnabled ? "" : "disabled"}`}
            >
              <span>{t("recordingsDownloadPath")}</span>
              <button
                className="path-button"
                onClick={async () => {
                  const path = await ipcRenderer.invoke(
                    "recordings:select-download-path",
                  )
                  if (path)
                    updateSettigns({
                      ...settings,
                      recordingsDownloadPath: path,
                    })
                }}
              >
                {settings.recordingsDownloadPath}
              </button>
              <span className="desc">{t("recordingsDownloadPath_desc")}</span>
            </div>
            <div
              className={`setting ${settings.recordingsEnabled ? "" : "disabled"}`}
            >
              <span>{t("recordingsMaxConcurrent")}</span>
              <input
                type="number"
                min={1}
                max={5}
                value={settings.recordingsMaxConcurrent}
                onChange={e => {
                  let val = parseInt(e.target.value)
                  if (val < 1) val = 1
                  if (val > 5) val = 5
                  updateSettigns({ ...settings, recordingsMaxConcurrent: val })
                }}
              />
              <span className="desc">{t("recordingsMaxConcurrent_desc")}</span>
            </div>
            <div className="setting">
              <span>{t("recordingsAutoDownload")}</span>
              <Switch
                onChange={v =>
                  updateSettigns({ ...settings, recordingsAutoDownload: v })
                }
                checked={settings.recordingsAutoDownload}
              />
            </div>
            <div className="setting">
              <span>{t("recordingsAutoTranscribe")}</span>
              <Switch
                disabled={!settings.recordingsAutoDownload}
                onChange={v =>
                  updateSettigns({ ...settings, recordingsAutoTranscribe: v })
                }
                checked={
                  settings.recordingsAutoDownload &&
                  settings.recordingsAutoTranscribe
                }
              />
            </div>
            <div className="setting">
              <span>{t("recordingsStartCollapsed")}</span>
              <Switch
                onChange={v =>
                  updateSettigns({
                    ...settings,
                    recordingsStartCollapsed: v,
                  })
                }
                checked={settings.recordingsStartCollapsed}
              />
              <span className="desc">{t("recordingsStartCollapsed_desc")}</span>
            </div>
          </div>

          <div className="setting-section">
            <h3>{t("transcriberSection")}</h3>
            <div className="setting">
              <span>{t("transcriberOutputPath")}</span>
              <input
                type="text"
                value={settings.transcriberOutputPath}
                onChange={e =>
                  updateSettigns({
                    ...settings,
                    transcriberOutputPath: e.target.value,
                  })
                }
              />
            </div>
            <div className="setting">
              <span>{t("transcriberWhisperModel")}</span>
              <select
                value={settings.transcriberWhisperModel}
                onChange={e =>
                  updateSettigns({
                    ...settings,
                    transcriberWhisperModel: e.target.value,
                  })
                }
              >
                <option value="tiny">tiny</option>
                <option value="base">base</option>
                <option value="small">small</option>
                <option value="medium">medium</option>
                <option value="large-v3">large-v3</option>
                <option value="turbo">turbo</option>
              </select>
              <span className="desc">{t("transcriberWhisperModel_desc")}</span>
            </div>
            <div className="setting">
              <span>{t("transcriberWhisperNumCores")}</span>
              <input
                type="number"
                min={1}
                max={64}
                value={settings.transcriberWhisperNumCores}
                onChange={e => {
                  const parsed = Number.parseInt(e.target.value, 10)
                  const value = Number.isFinite(parsed)
                    ? Math.min(64, Math.max(1, parsed))
                    : 2
                  updateSettigns({
                    ...settings,
                    transcriberWhisperNumCores: value,
                  })
                }}
              />
              <span className="desc">
                {t("transcriberWhisperNumCores_desc")}
              </span>
            </div>
            <div className="setting">
              <span>{t("transcriberNotesMode")}</span>
              <select
                value={settings.transcriberNotesMode}
                onChange={e =>
                  updateSettigns({
                    ...settings,
                    transcriberNotesMode: e.target.value as
                      | "transcript-only"
                      | "prompt-pack"
                      | "api",
                  })
                }
              >
                <option value="transcript-only">{t("transcriptOnly")}</option>
                <option value="prompt-pack">{t("promptPack")}</option>
                <option value="api">{t("generatedNotes")}</option>
              </select>
            </div>
          </div>

          <button
            className="danger-button"
            onClick={() => {
              ipcRenderer.send("logout")
            }}
          >
            {t("logout")}
          </button>

          <span className="credits">
            <span>v{version}</span>
            <br />
            Developed by Tommaso Morganti •{" "}
            <Link href="https://github.com/toto04">GitHub</Link>
            <br />
            <Link href="https://github.com/toto04/webeep-sync">
              Source code
            </Link>{" "}
            •&nbsp;
            <Link href="https://github.com/toto04/webeep-sync/issues">
              Report a Bug
            </Link>
            <br />
            <br />
            <Link href="https://polinetwork.org" style={{ color: "#888" }}>
              <PolinetworkLogo fill="#888" height={32} width={32} />
              <br />
              Powered by PoliNetwork
            </Link>
          </span>

          <div className="button-line-container">
            <button
              className="discard-button"
              onClick={() => {
                if (prevTheme) ipcRenderer.send("set-native-theme", prevTheme)
                props.onClose()
              }}
            >
              {t("cancel")}
            </button>
            <button
              className="confirm-button"
              onClick={async () => {
                await ipcRenderer.invoke("set-settings", settings)
                props.onClose()
              }}
            >
              {t("ok")}
            </button>
          </div>
        </div>
      ) : undefined}
    </Modal>
  )
}

// Kept temporarily for migration compatibility with the earlier prototype.
// eslint-disable-next-line @typescript-eslint/no-unused-vars, react/no-multi-comp
const SPIDCredentialsForm: FC = () => {
  const { t } = useTranslation("client", { keyPrefix: "settings" })
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [email, setEmail] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadCredentials()
  }, [])

  const loadCredentials = async () => {
    try {
      const creds = await ipcRenderer.invoke("recordings:get-credentials")
      if (creds) {
        setUsername(creds.username)
        setPassword(creds.password)
        setEmail(creds.polimiEmail)
        setSaved(true)
      }
    } catch (e) {
      console.error("Failed to load credentials:", e)
    }
  }

  const handleSave = async () => {
    if (!username || !password || !email) {
      alert(t("fillAllFields"))
      return
    }
    setLoading(true)
    try {
      await ipcRenderer.invoke("recordings:set-credentials", {
        username,
        password,
        polimiEmail: email,
      })
      setSaved(true)
      alert(t("credentialsSaved"))
    } catch (e) {
      console.error("Failed to save credentials:", e)
      alert(t("credentialsSaveError"))
    } finally {
      setLoading(false)
    }
  }

  const handleClear = async () => {
    if (!window.confirm(t("confirmClearCredentials"))) return
    setLoading(true)
    try {
      await ipcRenderer.invoke("recordings:clear-credentials")
      setUsername("")
      setPassword("")
      setEmail("")
      setSaved(false)
      alert(t("credentialsCleared"))
    } catch (e) {
      console.error("Failed to clear credentials:", e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="spid-credentials-form">
      <div className="credential-field">
        <label>
          <IoMail />
          <span>{t("spidUsername")}</span>
        </label>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder={t("spidUsernamePlaceholder")}
        />
      </div>
      <div className="credential-field">
        <label>
          <IoLockClosed />
          <span>{t("spidPassword")}</span>
        </label>
        <div className="password-input">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t("spidPasswordPlaceholder")}
          />
          <button
            type="button"
            className="toggle-visibility"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? <IoEyeOff /> : <IoEye />}
          </button>
        </div>
      </div>
      <div className="credential-field">
        <label>
          <IoMail />
          <span>{t("polimiEmail")}</span>
        </label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder={t("polimiEmailPlaceholder")}
        />
      </div>
      <div className="credential-actions">
        <button
          className="confirm-button"
          onClick={handleSave}
          disabled={loading}
        >
          {loading
            ? t("saving")
            : saved
              ? t("updateCredentials")
              : t("saveCredentials")}
        </button>
        {saved && (
          <button
            className="danger-button"
            onClick={handleClear}
            disabled={loading}
          >
            {t("clearCredentials")}
          </button>
        )}
      </div>
      <span className="credential-note">{t("credentialsNote")}</span>
    </div>
  )
}
