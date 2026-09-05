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
import {
  groupRecordings,
  canDownload,
  canTranscribe,
  isRecordingBusy,
  RecordingFilter,
  RecordingSort,
} from "../../modules/recording-catalog"
import type { RecordingDiscoveryProgress } from "../../modules/recordings"
import { RecordingCatalogItem } from "../../modules/recordings-types"
import { Checkbox } from "../components/Checkbox"

export const RecordingsView: FC = () => {
  const { t, i18n } = useTranslation("client", { keyPrefix: "recordings" })
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
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<RecordingFilter>("all")
  const [sort, setSort] = useState<RecordingSort>("newest")
  const [discoveryProgress, setDiscoveryProgress] =
    useState<RecordingDiscoveryProgress | null>(null)
  const [discoveryFailures, setDiscoveryFailures] = useState<string[]>([])

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

    ipcRenderer
      .invoke("recordings:get-sync-state")
      .then(state => {
        setSyncing(state.syncing)
        setDiscoveryProgress(state.progress)
      })
      .catch(err => setOperationError(String(err)))
    const onDiscoveryProgress = (
      _event: unknown,
      progress: RecordingDiscoveryProgress,
    ) => setDiscoveryProgress(progress)
    const onSettings = (
      _event: unknown,
      value: { recordingsStartCollapsed?: boolean },
    ) => {
      setStartCollapsed(value.recordingsStartCollapsed !== false)
      setCollapsedCourses({})
    }
    const onSync = (_e: unknown, value: boolean) => {
      setSyncing(value)
      if (value) {
        setDiscoveryFailures([])
        setDiscoveryMessage("")
        setOperationError("")
      } else setDiscoveryProgress(null)
    }
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
          newCount: result.newCount,
          activities: result.activitiesChecked,
          courses: result.coursesChecked,
        }),
      )
      setDiscoveryFailures(result.failures || [])
    }
    const onDiscoveryError = (_e: unknown, message: string) =>
      setOperationError(message)
    ipcRenderer.on("recordings-discovery-progress", onDiscoveryProgress)
    ipcRenderer.on("settings-updated", onSettings)
    ipcRenderer.on("recordings-syncing", onSync)
    ipcRenderer.on("recordings-catalog", onCatalog)
    ipcRenderer.on("recording-progress", onProgress)
    ipcRenderer.on("recordings-sync-complete", onComplete)
    ipcRenderer.on("recordings-sync-error", onDiscoveryError)
    return () => {
      ipcRenderer.removeListener(
        "recordings-discovery-progress",
        onDiscoveryProgress,
      )
      ipcRenderer.removeListener("settings-updated", onSettings)
      ipcRenderer.removeListener("recordings-syncing", onSync)
      ipcRenderer.removeListener("recordings-catalog", onCatalog)
      ipcRenderer.removeListener("recording-progress", onProgress)
      ipcRenderer.removeListener("recordings-sync-complete", onComplete)
      ipcRenderer.removeListener("recordings-sync-error", onDiscoveryError)
    }
  }, [t])

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

  const items = useMemo(() => Object.values(catalog), [catalog])
  const courseGroups = useMemo(
    () => groupRecordings(items, query, filter, sort),
    [items, query, filter, sort],
  )
  const visibleItems = courseGroups.flatMap(group => group.items)
  const selectedItems = visibleItems.filter(
    item => selected[item.recording.recordingId],
  )
  const selectedIds = selectedItems.map(item => item.recording.recordingId)
  const downloadIds = selectedItems
    .filter(canDownload)
    .map(item => item.recording.recordingId)
  const transcribeIds = selectedItems
    .filter(canTranscribe)
    .map(item => item.recording.recordingId)
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

      <div className="recordings-filters">
        <input
          type="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <select
          aria-label={t("filter")}
          value={filter}
          onChange={event => setFilter(event.target.value as RecordingFilter)}
        >
          {[
            "all",
            "available",
            "downloaded",
            "active",
            "completed",
            "error",
          ].map(value => (
            <option key={value} value={value}>
              {t(`filters.${value}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t("sort")}
          value={sort}
          onChange={event => setSort(event.target.value as RecordingSort)}
        >
          {["newest", "oldest", "title"].map(value => (
            <option key={value} value={value}>
              {t(`sorts.${value}`)}
            </option>
          ))}
        </select>
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
            disabled={!downloadIds.length}
            onClick={() => invoke("recordings:download", downloadIds)}
          >
            <IoCloudDownload /> {t("downloadSelected")}
          </button>
          <button
            className="confirm-button"
            disabled={!transcribeIds.length}
            onClick={() => invoke("recordings:transcribe", transcribeIds)}
          >
            <IoDocumentText /> {t("transcribeSelected")}
          </button>
        </div>
      </div>

      <details className="recordings-manual">
        <summary>{t("manualAdd")}</summary>
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
      </details>

      {syncing && discoveryProgress && (
        <div className="discovery-progress" role="status">
          <span>
            {t("discoveryProgress", {
              completed: discoveryProgress.coursesChecked,
              total: discoveryProgress.coursesTotal,
              activities: discoveryProgress.activitiesChecked,
            })}
          </span>
          <span>
            {discoveryProgress.courseName}
            {discoveryProgress.activityName
              ? ` · ${discoveryProgress.activityName}`
              : ""}
          </span>
        </div>
      )}
      {discoveryFailures.length > 0 && (
        <details className="discovery-failures">
          <summary>
            {t("discoveryFailures", { count: discoveryFailures.length })}
          </summary>
          <ul>
            {discoveryFailures.map((failure, index) => (
              <li key={index}>{failure}</li>
            ))}
          </ul>
        </details>
      )}
      {operationError ? (
        <div className="error-status" role="alert">
          {operationError}
        </div>
      ) : null}
      {discoveryMessage ? (
        <div className="notes-message" role="status">
          {discoveryMessage}
        </div>
      ) : null}

      <div className="recordings-list-tools">
        <span>
          {t("showing", { count: visibleItems.length, total: items.length })}
        </span>
        <div>
          <button
            className="text-button"
            onClick={() =>
              setCollapsedCourses(
                Object.fromEntries(
                  courseGroups.map(group => [group.courseId, false]),
                ),
              )
            }
          >
            {t("expandAll")}
          </button>
          <button
            className="text-button"
            onClick={() =>
              setCollapsedCourses(
                Object.fromEntries(
                  courseGroups.map(group => [group.courseId, true]),
                ),
              )
            }
          >
            {t("collapseAll")}
          </button>
          <button
            className="text-button"
            disabled={syncing}
            title={t("rescanHelp")}
            onClick={() => invoke("recordings:sync-now", true)}
          >
            {t("rescanAll")}
          </button>
        </div>
      </div>
      {!visibleItems.length ? (
        <div className="recordings-empty">
          <p>{items.length ? t("noMatches") : t("noRecordings")}</p>
        </div>
      ) : (
        <div className="recordings-list">
          {courseGroups.map(group => {
            const collapsed = collapsedCourses[group.courseId] ?? startCollapsed
            const groupIds = group.items.map(item => item.recording.recordingId)
            const allSelected = groupIds.every(id => selected[id])
            return (
              <div className="recordings-course-group" key={group.courseId}>
                <div className="recordings-course-header">
                  <button
                    className="course-collapse-button"
                    onClick={() =>
                      setCollapsedCourses(previous => {
                        const isCollapsed =
                          previous[group.courseId] ?? startCollapsed
                        return {
                          ...previous,
                          [group.courseId]: !isCollapsed,
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
                      const busy = isRecordingBusy(item)
                      const date = item.recording.date
                        ? new Date(item.recording.date)
                        : null
                      const progress = Math.max(
                        0,
                        Math.min(1, item.progress || 0),
                      )
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
                            ariaLabel={t("selectRecording", {
                              title: item.recording.title,
                            })}
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
                              <span>
                                {date && !Number.isNaN(date.getTime())
                                  ? date.toLocaleDateString(i18n.language, {
                                      day: "numeric",
                                      month: "short",
                                      year: "numeric",
                                    })
                                  : t("unknownDate")}
                              </span>
                              <span
                                className={`recording-status ${item.status}`}
                              >
                                {transcriptionStageLabel}
                                {showProgress
                                  ? ` · ${Math.round(progress * 100)}%`
                                  : ""}
                              </span>
                            </div>
                            {showProgress ? (
                              <div className="progress-bar">
                                <div
                                  className="progress-bar-inside"
                                  style={{
                                    width: `${Math.max(2, progress * 100)}%`,
                                  }}
                                />
                              </div>
                            ) : null}
                            {item.error ? (
                              <span className="error-status">{item.error}</span>
                            ) : null}
                          </div>
                          <div className="recording-actions">
                            {canDownload(item) && (
                              <button
                                className="icon-button"
                                aria-label={t("download")}
                                title={t("download")}
                                onClick={() =>
                                  invoke("recordings:download", [recordingId])
                                }
                              >
                                <IoCloudDownload />
                              </button>
                            )}
                            {canTranscribe(item) && (
                              <button
                                className="icon-button"
                                aria-label={t("transcribe")}
                                title={t("transcribe")}
                                onClick={() =>
                                  invoke("recordings:transcribe", [recordingId])
                                }
                              >
                                <IoDocumentText />
                              </button>
                            )}
                            {(item.notesPath || item.transcriptPath) && (
                              <button
                                className="icon-button"
                                aria-label={
                                  item.notesPath
                                    ? t("openNotes")
                                    : t("openTranscript")
                                }
                                title={
                                  item.notesPath
                                    ? t("openNotes")
                                    : t("openTranscript")
                                }
                                onClick={() =>
                                  invoke(
                                    "recordings:open-artifact",
                                    recordingId,
                                    item.notesPath ? "notes" : "transcript",
                                  )
                                }
                              >
                                <IoDocumentText />
                              </button>
                            )}

                            {busy ? (
                              <button
                                className="icon-button danger"
                                aria-label={t("cancel")}
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
                                  aria-label={t("play")}
                                  title={t("play")}
                                >
                                  <IoPlayCircle />
                                </button>
                                <button
                                  className="icon-button danger"
                                  disabled={busy}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        t("confirmDelete", {
                                          title: item.recording.title,
                                        }),
                                      )
                                    )
                                      void invoke(
                                        "recordings:delete",
                                        recordingId,
                                      )
                                  }}
                                  aria-label={t("delete")}
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
