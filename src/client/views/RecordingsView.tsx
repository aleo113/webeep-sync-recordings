import { ipcRenderer } from "electron"
import React, { FC, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  IoCloudDownload,
  IoDocumentText,
  IoPlayCircle,
  IoRefreshCircle,
  IoStopCircle,
  IoTrashBin,
} from "react-icons/io5"
import { RecordingCatalogItem } from "../../modules/recordings-types"

export const RecordingsView: FC = () => {
  const { t } = useTranslation("client", { keyPrefix: "recordings" })
  const [catalog, setCatalog] = useState<Record<string, RecordingCatalogItem>>(
    {},
  )
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [operationError, setOperationError] = useState("")
  const [discoveryMessage, setDiscoveryMessage] = useState("")

  useEffect(() => {
    ipcRenderer
      .invoke("recordings:get-catalog")
      .then(value => setCatalog(value || {}))
      .catch(err => setOperationError(String(err)))
      .finally(() => setLoading(false))

    const onSync = (_e: unknown, value: boolean) => setSyncing(value)
    const onCatalog = (
      _e: unknown,
      value: Record<string, RecordingCatalogItem>,
    ) => setCatalog(value || {})
    const onProgress = (
      _e: unknown,
      data: { recordingId: string; item: RecordingCatalogItem },
    ) => {
      setCatalog(previous => ({
        ...previous,
        [data.recordingId]: data.item,
      }))
    }
    const onComplete = (
      _e: unknown,
      result: {
        discovered: number
        newCount: number
        coursesChecked: number
        activitiesChecked: number
        failures: string[]
      },
    ) => {
      setDiscoveryMessage(
        t("discoverySummary", {
          recordings: result.discovered,
          activities: result.activitiesChecked,
          courses: result.coursesChecked,
        }),
      )
      setOperationError(result.failures?.join("\n") || "")
    }
    const onDiscoveryError = (_e: unknown, message: string) =>
      setOperationError(message)
    ipcRenderer.on("recordings-syncing", onSync)
    ipcRenderer.on("recordings-catalog", onCatalog)
    ipcRenderer.on("recording-progress", onProgress)
    ipcRenderer.on("recordings-sync-complete", onComplete)
    ipcRenderer.on("recordings-sync-error", onDiscoveryError)
    return () => {
      ipcRenderer.removeListener("recordings-syncing", onSync)
      ipcRenderer.removeListener("recordings-catalog", onCatalog)
      ipcRenderer.removeListener("recording-progress", onProgress)
      ipcRenderer.removeListener("recordings-sync-complete", onComplete)
      ipcRenderer.removeListener("recordings-sync-error", onDiscoveryError)
    }
  }, [])

  const selectedIds = useMemo(
    () => Object.keys(selected).filter(id => selected[id]),
    [selected],
  )

  const invoke = async (channel: string, ...args: unknown[]) => {
    setOperationError("")
    try {
      await ipcRenderer.invoke(channel, ...args)
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : String(err))
    }
  }

  const items = Object.values(catalog).sort(
    (a, b) => b.discoveredAt - a.discoveredAt,
  )
  if (loading) {
    return (
      <div className="recordings-view section">
        <div className="loading">{t("loading")}</div>
      </div>
    )
  }

  return (
    <div className="recordings-view section">
      <div className="recordings-header">
        <h2>{t("title")}</h2>
        <button
          className={`sync-button ${syncing ? "syncing" : ""}`}
          onClick={() => invoke("recordings:sync-now")}
          disabled={syncing}
        >
          <IoRefreshCircle className={syncing ? "spin" : ""} />
          {syncing ? t("syncing") : t("syncNow")}
        </button>
      </div>

      <div className="button-row">
        <button
          className="confirm-button"
          disabled={!selectedIds.length}
          onClick={() => invoke("recordings:download", selectedIds)}
        >
          <IoCloudDownload /> {t("downloadSelected")}
        </button>
        <button
          className="confirm-button"
          disabled={!selectedIds.length}
          onClick={() => invoke("recordings:transcribe", selectedIds)}
        >
          <IoDocumentText /> {t("transcribeSelected")}
        </button>
      </div>

      {operationError ? (
        <div className="error-status">{operationError}</div>
      ) : null}
      {discoveryMessage ? (
        <div className="notes-message">{discoveryMessage}</div>
      ) : null}

      {!items.length ? (
        <div className="recordings-empty">
          <p>{t("noRecordings")}</p>
        </div>
      ) : (
        <div className="recordings-list">
          {items.map(item => {
            const recordingId = item.recording.recordingId
            const busy =
              item.status === "downloading" || item.status === "transcribing"
            return (
              <div key={recordingId} className="recording-item">
                <input
                  type="checkbox"
                  checked={!!selected[recordingId]}
                  onChange={() =>
                    setSelected(previous => ({
                      ...previous,
                      [recordingId]: !previous[recordingId],
                    }))
                  }
                />
                <div className="recording-info">
                  <span className="recording-course">
                    {item.recording.title}
                  </span>
                  <span className="recording-date">
                    {item.recording.courseName} · {t(`status.${item.status}`)}
                    {typeof item.progress === "number"
                      ? ` · ${Math.round(item.progress * 100)}%`
                      : ""}
                  </span>
                  {item.error ? (
                    <span className="error-status">{item.error}</span>
                  ) : null}
                </div>
                <div className="recording-actions">
                  {busy ? (
                    <button
                      className="icon-button danger"
                      title={t("cancel")}
                      onClick={() => invoke("recordings:cancel", recordingId)}
                    >
                      <IoStopCircle />
                    </button>
                  ) : null}
                  {item.filePath ? (
                    <>
                      <button
                        className="icon-button"
                        onClick={() => invoke("recordings:open", recordingId)}
                        title={t("play")}
                      >
                        <IoPlayCircle />
                      </button>
                      <button
                        className="icon-button danger"
                        onClick={() => invoke("recordings:delete", recordingId)}
                        title={t("delete")}
                      >
                        <IoTrashBin />
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
