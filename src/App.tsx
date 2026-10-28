import { useCallback, useEffect, useRef } from "react"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ViewerPane } from "@/components/ViewerPane"
import { TopBar } from "@/components/TopBar"
import { openSource } from "@/lib/h5j"
import {
  readUsableMarker,
  touchDataset,
  trimDatasets,
} from "@/lib/datasets"
import { formatBytes } from "@/lib/bytes"
import { holdDataset } from "@/lib/locks"
import {
  EXPIRY_MS,
  saveKeepWhenDiskLow,
  saveStorageLimitGb,
  storageLimit,
} from "@/lib/prefs"
import { ingestH5J, reuseDataset, sourceKey } from "@/lib/ingest"
import type { SourceKey } from "@/lib/ingest"
import {
  clearAllDatasets,
  isPersisted,
  requestPersist,
  storageEstimate,
} from "@/lib/opfs"
import {
  basenameOf,
  NO_PARAMS,
  parseParams,
  serializeParams,
  visibleIndices,
} from "@/lib/url"
import {
  clearFinished,
  colorChanged,
  opacityChanged,
  sliceScrubbed,
  launchParsed,
  clearStarted,
  settingsOpened,
  persistResult,
  visibilityChanged,
  sourceFailed,
  sourceOpened,
  sourceOpening,
  storageUpdated,
  ingestDetails,
  keepWhenDiskLowChanged,
  storageLimitChanged,
} from "@/state/actions"
import { useAppState, useDispatch } from "@/state/context"
import { initialControls } from "@/state/reducer"
import { isBusy, projectedBytes, zoomToPersist } from "@/state/selectors"
import type { DragEvent } from "react"
import type { LaunchParams } from "@/lib/url"
import type { ChannelControls, H5JInfo } from "@/types"
import type { H5JFile } from "@janelia/web-h5j-loader"

export function App() {
  const state = useAppState()
  const dispatch = useDispatch()

  // The open jsfive container. A handle to a live object, not state: it is not
  // serializable, nothing renders from it, and every reader is inside a callback.
  const fileRef = useRef<H5JFile | null>(null)

  const { launch, source, controls, dataset, ingest, storage, ui, camera } =
    state
  // The dataset the viewer currently has mounted, in a ref so the ingest callback sees
  // the live value rather than the one from the render that created it.
  const mountedIdRef = useRef<string | null>(null)
  useEffect(() => {
    mountedIdRef.current = dataset.id
  }, [dataset.id])

  // Moves the mounted dataset to the back of the eviction queue, so the one you are
  // looking at is the last thing discarded to make room for something else.
  useEffect(() => {
    if (!dataset.id) return
    void touchDataset(dataset.id, Date.now())
  }, [dataset.id])

  // Marks the mounted dataset as in use for as long as it is on screen, so another tab's
  // startup trim leaves it alone -- deleting it would turn this view black, silently.
  useEffect(() => {
    if (!dataset.id) return
    return holdDataset(dataset.id)
  }, [dataset.id])

  const refreshStorage = useCallback(() => {
    storageEstimate().then(
      ({ usage, quota }) => dispatch(storageUpdated(usage, quota)),
      () => undefined
    )
  }, [dispatch])

  // Persistence is asked for only when the user has opted in. Persisted storage is exempt
  // from the browser's own cleanup when the disk runs low, and that cleanup is the only
  // thing that ever clears an origin this app is no longer opened on -- so asking by
  // default is how converted volumes piled up unseen. Otherwise just report what the
  // browser has already granted, since a grant cannot be withdrawn by the site.
  // Re-run when the setting changes, which is what makes ticking the box ask.
  const keepWhenDiskLow = storage.keepWhenDiskLow
  useEffect(() => {
    refreshStorage()
    ;(keepWhenDiskLow ? requestPersist() : isPersisted()).then(
      (persisted) => dispatch(persistResult(persisted)),
      () => dispatch(persistResult(false))
    )
  }, [dispatch, keepWhenDiskLow, refreshStorage])

  /**
   * Bring storage back within its limit, sparing `keep` and anything another tab holds.
   * Run once per page load, after the volume being opened is safely mounted (or has
   * failed), so it can never delete the one about to be shown, and never runs alongside
   * this tab's own conversion.
   */
  const limitGb = storage.limitGb
  const trimStorage = useCallback(
    async (keep: Array<string | null>) => {
      const { quota } = await storageEstimate().catch(() => ({ quota: 0 }))
      const { removed, reclaimed } = await trimDatasets({
        limit: storageLimit(quota, limitGb).bytes,
        now: Date.now(),
        maxAgeMs: EXPIRY_MS,
        keep: keep.filter((id): id is string => id !== null),
      })
      if (removed > 0) {
        dispatch(
          ingestDetails([
            `Removed ${removed} old volume${removed === 1 ? "" : "s"} ` +
              `(${formatBytes(reclaimed)}) to stay within the storage limit.`,
          ])
        )
        refreshStorage()
      }
    },
    [dispatch, limitGb, refreshStorage]
  )

  // Storage is otherwise only measured at mount, after a whole conversion and after a
  // clear -- so during the one stretch where it changes by gigabytes, the figure sat
  // still. Polling only while busy: `estimate()` is not free, and outside a conversion
  // nothing in this tab moves the number.
  const busy = isBusy(state)
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(refreshStorage, 1500)
    return () => clearInterval(timer)
  }, [busy, refreshStorage])

  // Returns the container so a caller can act on it immediately; reading it back out
  // of the store would mean waiting for a render.
  const onSelectSource = useCallback(
    async (src: File | string): Promise<H5JInfo | null> => {
      dispatch(sourceOpening())
      try {
        const { file, info } = await openSource(src)
        fileRef.current = file
        const url = typeof src === "string" ? src : null
        const name = basenameOf(typeof src === "string" ? src : src.name)
        dispatch(sourceOpened(info, name, url))
        return info
      } catch (exc) {
        dispatch(sourceFailed(exc instanceof Error ? exc.message : String(exc)))
        return null
      }
    },
    [dispatch]
  )

  const onIngest = useCallback(
    async (
      info: H5JInfo,
      channelControls: ChannelControls,
      key: SourceKey,
      url: string | null
    ) => {
      const file = fileRef.current
      if (!file) return
      try {
        await ingestH5J(
          {
            file,
            info,
            sourceName: key.name,
            datasetId: key.datasetId,
            controls: channelControls,
            origin: location.origin,
            sourceUrl: url,
            storageLimitGb: storage.limitGb,
            // Read from the ref rather than from `dataset.id`: this callback closes
            // over the render it was made in, and the previous dataset is exactly what
            // eviction must not remove while its layers are still mounted.
            mountedDatasetId: mountedIdRef.current,
            launch,
          },
          dispatch
        )
      } finally {
        refreshStorage()
      }
    },
    [dispatch, launch, refreshStorage, storage.limitGb]
  )

  /**
   * Show this source from what is already on disk, if it is there. The dataset's id when
   * it worked, null otherwise.
   *
   * Tried BEFORE the file is opened, which is the whole saving: the download and the
   * decode are nearly all of the cost, and neither happens on a hit. That is only
   * possible because the dataset id is derived from the source rather than from the
   * file's contents, and because the marker records the geometry and contrast that
   * would otherwise have to be measured.
   *
   * `key` must be the same one the conversion is given, which is what guarantees this
   * finds what an earlier conversion wrote.
   */
  const tryReuse = useCallback(
    async (
      src: File | string,
      params: LaunchParams,
      key: SourceKey
    ): Promise<string | null> => {
      try {
        const url = typeof src === "string" ? src : null
        const marker = await readUsableMarker(key.datasetId)
        if (!marker) return null

        dispatch(sourceOpened(marker.info, marker.name || key.name, url))
        const mounted = await reuseDataset(
          {
            marker,
            controls: initialControls(marker.info, params),
            origin: location.origin,
            launch: params,
          },
          dispatch
        )
        if (!mounted) return null
        void touchDataset(marker.id, Date.now())
        return marker.id
      } catch {
        // Any failure here means converting instead, which always works. Reuse is an
        // optimization, and an optimization that can break a load is not one.
        return null
      }
    },
    [dispatch]
  )

  // Local files arrive by being dropped on the viewer. The URL is the only other way
  // in, so this is what keeps local files loadable without spending any bar space on a
  // file input. A dropped file has no URL, so nothing is written to the address bar and
  // the session is not shareable.
  const onDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault()
      const file = event.dataTransfer.files[0]
      if (!file) return
      const key = await sourceKey(file)
      if (await tryReuse(file, NO_PARAMS, key)) return
      const info = await onSelectSource(file)
      if (!info) return
      await onIngest(info, initialControls(info, NO_PARAMS), key, null)
    },
    [onIngest, onSelectSource, tryReuse]
  )

  // Parse the address bar once, and if it names a file, load and convert it without
  // any interaction. This is what lets another web app launch this one with data, and
  // what makes a link reloadable.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    const params = parseParams(location.search)
    dispatch(launchParsed(params))
    if (!params.h5jUrl) {
      void trimStorage([])
      return
    }

    void (async () => {
      // Worked out once and handed to both the reuse check and the conversion, so the
      // conversion is written exactly where the next reload will look for it.
      const key = await sourceKey(params.h5jUrl!)
      const reused = await tryReuse(params.h5jUrl!, params, key)
      if (reused) {
        await trimStorage([reused])
        return
      }

      const info = await onSelectSource(params.h5jUrl!)
      if (!info) {
        await trimStorage([])
        return
      }
      // SOURCE_OPENED has already built these, but the reducer's result is not
      // readable until the next render, so derive them again rather than starting the
      // conversion a render late.
      await onIngest(info, initialControls(info, params), key, params.h5jUrl!)
      // After, not before: during the conversion, making room is the conversion's own
      // job, and the new volume is mounted by now so it is spared along with anything
      // another tab is showing.
      await trimStorage([mountedIdRef.current])
    })()
  }, [dispatch, onIngest, onSelectSource, trimStorage, tryReuse])

  // Keep the address bar in step with what is loaded, so a reload or a shared link
  // reproduces it. `replaceState` rather than `pushState`: these updates are
  // incidental to the user's own navigation and should not fill the back stack.
  useEffect(() => {
    if (!source.h5jUrl) return
    const timer = setTimeout(() => {
      const search = serializeParams({
        ...launch,
        h5jUrl: source.h5jUrl,
        channels: visibleIndices(controls.visible),
        colors: controls.colors,
        position: camera.position ?? launch.position,
        // Only a zoom the user chose is worth carrying. On load the view is fitted to its
        // pane, and that fitted default is left out of the URL so a plain reload fits again
        // rather than pinning the fit; the moment the user zooms off it, the zoom is saved
        // and a shared link restores it.
        zoom: zoomToPersist(camera.zoom, camera.defaultZoom),
      })
      history.replaceState(null, "", `${location.pathname}${search}`)
    }, URL_WRITE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [
    camera.position,
    camera.zoom,
    camera.defaultZoom,
    controls.colors,
    controls.visible,
    launch,
    source.h5jUrl,
  ])

  const onToggleVisibility = useCallback(
    (index: number) => {
      const next = controls.visible.map((shown, i) =>
        i === index ? shown === false : shown !== false
      )
      dispatch(visibilityChanged(next))
    },
    [controls.visible, dispatch]
  )

  const onColorChange = useCallback(
    (index: number, color: string) => dispatch(colorChanged(index, color)),
    [dispatch]
  )

  const onOpacityChange = useCallback(
    (index: number, opacity: number) =>
      dispatch(opacityChanged(index, opacity)),
    [dispatch]
  )

  const onClear = useCallback(async () => {
    dispatch(clearStarted())
    try {
      await clearAllDatasets()
    } finally {
      dispatch(clearFinished())
      refreshStorage()
    }
  }, [dispatch, refreshStorage])

  // What is actually enforced: the user's cap, or less when the quota is tight.
  const limit = storageLimit(storage.quota, storage.limitGb)

  return (
    <div className="app">
      <TopBar
        channels={source.info?.channels ?? []}
        visible={controls.visible}
        ready={dataset.ready}
        colors={controls.colors}
        opacity={controls.opacity}
        convertingIndex={ingest.channelIndex}
        fraction={ingest.fraction}
        phase={ingest.phase}
        phaseDetail={ingest.detail}
        warnings={ingest.warnings}
        error={ingest.error}
        sourceName={source.name}
        sourceUrl={source.h5jUrl}
        sourceTitle={launch.title}
        sliceZ={camera.position ? camera.position[2] : null}
        sliceDepth={dataset.dims?.size.z ?? null}
        onScrub={(z) => dispatch(sliceScrubbed(z))}
        usage={storage.usage}
        quota={storage.quota}
        projected={projectedBytes(state)}
        persisted={storage.persisted}
        storageLimit={limit}
        onToggleVisibility={onToggleVisibility}
        onColorChange={onColorChange}
        onOpacityChange={onOpacityChange}
        onOpenSettings={() => dispatch(settingsOpened(true))}
      />

      <main
        className="viewer-area"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void onDrop(event)}
      >
        {dataset.viewerState && dataset.id ? (
          <ViewerPane origin={location.origin} />
        ) : (
          <p className="placeholder">
            Add <code>?h5j=</code> to the address with the URL of an H5J file,
            or drop one here. Nothing is uploaded — decoding and conversion
            happen in this tab.
          </p>
        )}
      </main>

      <SettingsDialog
        open={ui.settingsOpen}
        onClose={() => dispatch(settingsOpened(false))}
        usage={storage.usage}
        quota={storage.quota}
        persisted={storage.persisted}
        projected={projectedBytes(state)}
        sourceName={source.name}
        sourceUrl={source.h5jUrl}
        diagnostics={ingest.details}
        warnings={ingest.warnings}
        error={ingest.error}
        onClearAll={onClear}
        clearing={storage.clearing}
        limitGb={storage.limitGb}
        onLimitGbChange={(gb) => {
          dispatch(storageLimitChanged(gb))
          saveStorageLimitGb(gb)
        }}
        limit={limit}
        keepWhenDiskLow={storage.keepWhenDiskLow}
        onKeepWhenDiskLowChange={(keep) => {
          dispatch(keepWhenDiskLowChanged(keep))
          saveKeepWhenDiskLow(keep)
        }}
      />
    </div>
  )
}

/** Debounce for address-bar updates; pose changes will be continuous once wired up. */
const URL_WRITE_DELAY_MS = 300
