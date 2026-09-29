import { useCallback, useEffect, useRef } from "react"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ViewerPane } from "@/components/ViewerPane"
import { TopBar } from "@/components/TopBar"
import { openSource } from "@/lib/h5j"
import { readUsableMarker, touchDataset } from "@/lib/datasets"
import { saveEvictionPercent } from "@/lib/prefs"
import {
  ingestH5J,
  makeDatasetId,
  reuseDataset,
  sourceIdentity,
} from "@/lib/ingest"
import { clearAllDatasets, requestPersist, storageEstimate } from "@/lib/opfs"
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
  evictionPercentChanged,
} from "@/state/actions"
import { useAppState, useDispatch } from "@/state/context"
import { initialControls } from "@/state/reducer"
import { isBusy, projectedBytes, zoomToPersist } from "@/state/selectors"
import type { DragEvent } from "react"
import type { LaunchParams } from "@/lib/url"
import type { H5JInfo } from "@/types"
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

  const refreshStorage = useCallback(() => {
    storageEstimate().then(
      ({ usage, quota }) => dispatch(storageUpdated(usage, quota)),
      () => undefined
    )
  }, [dispatch])

  useEffect(() => {
    refreshStorage()
    requestPersist().then(
      (persisted) => dispatch(persistResult(persisted)),
      () => dispatch(persistResult(false))
    )
  }, [dispatch, refreshStorage])

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
      info = source.info,
      channelControls = controls,
      name = source.name,
      url = source.h5jUrl
    ) => {
      const file = fileRef.current
      if (!file || !info) return
      try {
        await ingestH5J(
          {
            file,
            info,
            sourceName: name,
            controls: channelControls,
            origin: location.origin,
            sourceUrl: url,
            evictionPercent: storage.evictionPercent,
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
    [
      controls,
      dispatch,
      launch,
      refreshStorage,
      storage.evictionPercent,
      source.h5jUrl,
      source.info,
      source.name,
    ]
  )

  /**
   * Show this source from what is already on disk, if it is there. True when it worked.
   *
   * Tried BEFORE the file is opened, which is the whole saving: the download and the
   * decode are nearly all of the cost, and neither happens on a hit. That is only
   * possible because the dataset id is derived from the source rather than from the
   * file's contents, and because the marker records the geometry and contrast that
   * would otherwise have to be measured.
   */
  const tryReuse = useCallback(
    async (src: File | string, params: LaunchParams): Promise<boolean> => {
      try {
        const url = typeof src === "string" ? src : null
        const name = basenameOf(typeof src === "string" ? src : src.name)
        const marker = await readUsableMarker(
          makeDatasetId(name, await sourceIdentity(src))
        )
        if (!marker) return false

        dispatch(sourceOpened(marker.info, marker.name || name, url))
        const mounted = await reuseDataset(
          {
            marker,
            controls: initialControls(marker.info, params),
            origin: location.origin,
            launch: params,
          },
          dispatch
        )
        if (mounted) void touchDataset(marker.id, Date.now())
        return mounted
      } catch {
        // Any failure here means converting instead, which always works. Reuse is an
        // optimization, and an optimization that can break a load is not one.
        return false
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
      if (await tryReuse(file, NO_PARAMS)) return
      const info = await onSelectSource(file)
      if (!info) return
      await onIngest(info, initialControls(info, NO_PARAMS), file.name, null)
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
    if (!params.h5jUrl) return

    void (async () => {
      if (await tryReuse(params.h5jUrl!, params)) return

      const info = await onSelectSource(params.h5jUrl!)
      if (!info) return
      // SOURCE_OPENED has already built these, but the reducer's result is not
      // readable until the next render, so derive them again rather than starting the
      // conversion a render late.
      // The URL is passed explicitly. Letting it default would read `source.h5jUrl`
      // from the render that created this callback -- which is before SOURCE_OPENED
      // set it -- so it would be null, and the dataset id would be built from the
      // basename instead of the URL. The id would then not match the one `tryReuse`
      // looks up, and no conversion would ever be found again.
      await onIngest(
        info,
        initialControls(info, params),
        basenameOf(params.h5jUrl!),
        params.h5jUrl!
      )
    })()
  }, [dispatch, onIngest, onSelectSource, tryReuse])

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
        sliceZ={camera.position ? camera.position[2] : null}
        sliceDepth={dataset.dims?.size.z ?? null}
        onScrub={(z) => dispatch(sliceScrubbed(z))}
        usage={storage.usage}
        quota={storage.quota}
        projected={projectedBytes(state)}
        persisted={storage.persisted}
        evictionPercent={storage.evictionPercent}
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
        evictionPercent={storage.evictionPercent}
        onEvictionPercentChange={(percent) => {
          dispatch(evictionPercentChanged(percent))
          saveEvictionPercent(percent)
        }}
      />
    </div>
  )
}

/** Debounce for address-bar updates; pose changes will be continuous once wired up. */
const URL_WRITE_DELAY_MS = 300
