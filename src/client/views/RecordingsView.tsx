import { ipcRenderer } from "electron"
import React, { FC, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  IoChevronDown,
  IoChevronForward,
  IoCloudDownload,
  IoDocumentText,
  IoPlayCircle,
  IoAddCircle,
  IoRefreshCircle,
  IoStopCircle,
  IoTrashBin,
} from "react-icons/io5"
import { RecordingCatalogItem } from "../../modules/recordings-types"
import { Checkbox } from "../components/Checkbox"

export const RecordingsView: FC = () => {
  const { t } = useTranslation("client", { keyPrefix: "recordings" })
  const [catalog, setCatalog] = useState<Record<string, RecordingCatalogItem>>(
    {},
  )
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [manualUrl, setManualUrl] = useState("")
  const [addingManual, setAddingManual] = useState(false)
  const [startCollapsed, setStartCollapsed] = useState(true)
  const [collapsedCourses, setCollapsedCourses] = useState<
    Record<string, boolean>
  >({})
  const [operationError, setOperationError] = useState("")
  const [discoveryMessage, setDiscoveryMessage] = useState("")

  useEffect(() => {
    ipcRenderer
      .invoke("recordings:get-catalog")
      .then(value => setCatalog(value || {}))
      .catch(err => setOperationError(String(err)))
      .finally(() => setLoading(false))
    ipcRenderer
      .invoke("settings")
      .then(value =>
        setStartCollapsed(value?.recordingsStartCollapsed !== false),
      )
      .catch(() => {
        // Keep the safe collapsed default if settings cannot be loaded.
      })

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

  const addManualRecording = async () => {
    if (!manualUrl.trim()) return
    setOperationError("")
    setAddingManual(true)
    try {
      await ipcRenderer.invoke("recordings:add-manual", manualUrl)
      setManualUrl("")
      setDiscoveryMessage(t("manualAdded"))
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddingManual(false)
    }
  }

  const items = Object.values(catalog).sort(
    (a, b) =>
      a.recording.courseName.localeCompare(b.recording.courseName) ||
      new Date(b.recording.date).getTime() -
        new Date(a.recording.date).getTime(),
  )
  const courseGroups = items.reduce<
    Array<{ courseName: string; items: RecordingCatalogItem[] }>
  >((groups, item) => {
    const previous = groups[groups.length - 1]
    if (previous?.courseName === item.recording.courseName) {
      previous.items.push(item)
    } else {
      groups.push({
        courseName: item.recording.courseName,
        items: [item],
      })
    }
    return groups
  }, [])
  const downloadingCount = items.filter(
    item => item.status === "downloading",
  ).length
  const transcribingCount = items.filter(
    item => item.status === "transcribing",
  ).length
  const queuedCount = items.filter(item => item.status === "queued").length
  const batchState = syncing
    ? t("batch.checking")
    : downloadingCount
      ? t("batch.downloading", { count: downloadingCount })
      : transcribingCount
        ? t("batch.transcribing", { count: transcribingCount }) +
          (queuedCount ? ` · ${t("batch.queued", { count: queuedCount })}` : "")
        : queuedCount
          ? t("batch.queued", { count: queuedCount })
          : t("batch.ready")
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
        <div className="recordings-heading">
          <div className="recordings-title-row">
            <h3>{t("title")}</h3>
            <span className="recordings-count">
              {t("recordingCount", { count: items.length })}
            </span>
            <span
              className={`batch-state ${
                syncing || downloadingCount || transcribingCount || queuedCount
                  ? "busy"
                  : ""
              }`}
            >
              {batchState}
            </span>
          </div>
          <span>{t("description")}</span>
        </div>
        <button
          className={`sync-button clickable ${syncing ? "syncing" : ""}`}
          onClick={() => invoke("recordings:sync-now")}
          disabled={syncing}
        >
          <IoRefreshCircle className={syncing ? "spin" : ""} />
          {syncing ? t("syncing") : t("syncNow")}
        </button>
      </div>

      <div className="recordings-toolbar">
        <span className="selection-count">
          {selectedIds.length
            ? t("selectedCount", { count: selectedIds.length })
            : t("selectHint")}
        </span>
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
      </div>

      <form
        className="recordings-manual-form"
        onSubmit={event => {
          event.preventDefault()
          addManualRecording()
        }}
      >
        <input
          type="url"
          value={manualUrl}
          onChange={event => setManualUrl(event.target.value)}
          placeholder={t("manualLinkPlaceholder")}
          aria-label={t("manualLinkLabel")}
        />
        <button
          className="confirm-button"
          type="submit"
          disabled={!manualUrl.trim() || addingManual}
        >
          <IoAddCircle />
          {addingManual ? t("manualAdding") : t("manualAdd")}
        </button>
      </form>

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
          {courseGroups.map(group => {
            const collapsed =
              collapsedCourses[group.courseName] ?? startCollapsed
            const groupIds = group.items.map(item => item.recording.recordingId)
            const allSelected = groupIds.every(id => selected[id])
            return (
              <div className="recordings-course-group" key={group.courseName}>
                <div className="recordings-course-header">
                  <button
                    className="course-collapse-button"
                    onClick={() =>
                      setCollapsedCourses(previous => {
                        const isCollapsed =
                          previous[group.courseName] ?? startCollapsed
                        return {
                          ...previous,
                          [group.courseName]: !isCollapsed,
                        }
                      })
                    }
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? <IoChevronForward /> : <IoChevronDown />}
                    <span>{group.courseName}</span>
                    <span className="course-recording-count">
                      {t("courseCount", { count: group.items.length })}
                    </span>
                  </button>
                  <button
                    className="course-select-button text-button"
                    onClick={() =>
                      setSelected(previous => {
                        const next = { ...previous }
                        for (const id of groupIds) next[id] = !allSelected
                        return next
                      })
                    }
                  >
                    {allSelected ? t("deselectAll") : t("selectAll")}
                  </button>
                </div>
                {!collapsed
                  ? group.items.map(item => {
                      const recordingId = item.recording.recordingId
                      const busy =
                        item.status === "downloading" ||
                        item.status === "queued" ||
                        item.status === "transcribing"
                      const transcriptionStageLabel =
                        item.status === "transcribing" &&
                        item.transcriptionStage === "materials"
                          ? t("status.processingMaterials")
                          : item.status === "transcribing" &&
                              item.transcriptionStage === "notes"
                            ? t("status.generatingNotes")
                            : item.status === "transcribing" &&
                                item.transcriptionStage === "starting"
                              ? t("status.preparingTranscription")
                              : t(`status.${item.status}`)
                      const showProgress =
                        busy &&
                        typeof item.progress === "number" &&
                        item.transcriptionStage !== "notes"
                      return (
                        <div key={recordingId} className="recording-item">
                          <Checkbox
                            value={!!selected[recordingId]}
                            color="#30d896"
                            onChange={() =>
                              setSelected(previous => ({
                                ...previous,
                                [recordingId]: !previous[recordingId],
                              }))
                            }
                          />
                          <div className="recording-info">
                            <span
                              className="recording-title"
                              title={item.recording.title}
                            >
                              {item.recording.title}
                            </span>
                            <div className="recording-meta">
                              <span
                                className={`recording-status ${item.status}`}
                              >
                                {transcriptionStageLabel}
                                {showProgress
                                  ? ` · ${Math.round(item.progress * 100)}%`
                                  : ""}
                              </span>
                            </div>
                            {showProgress ? (
                              <div className="progress-bar">
                                <div
                                  className="progress-bar-inside"
                                  style={{
                                    width: `${Math.max(
                                      2,
                                      item.progress * 100,
                                    )}%`,
                                  }}
                                />
                              </div>
                            ) : null}
                            {item.error ? (
                              <span className="error-status">{item.error}</span>
                            ) : null}
                          </div>
                          <div className="recording-actions">
                            {busy ? (
                              <button
                                className="icon-button danger"
                                title={t("cancel")}
                                onClick={() =>
                                  invoke("recordings:cancel", recordingId)
                                }
                              >
                                <IoStopCircle />
                              </button>
                            ) : null}
                            {item.filePath ? (
                              <>
                                <button
                                  className="icon-button"
                                  onClick={() =>
                                    invoke("recordings:open", recordingId)
                                  }
                                  title={t("play")}
                                >
                                  <IoPlayCircle />
                                </button>
                                <button
                                  className="icon-button danger"
                                  onClick={() =>
                                    invoke("recordings:delete", recordingId)
                                  }
                                  title={t("delete")}
                                >
                                  <IoTrashBin />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      )
                    })
                  : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
