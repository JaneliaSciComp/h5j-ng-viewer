import { useCallback, useEffect, useRef } from "react"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ViewerPane } from "@/components/ViewerPane"
import { TopBar } from "@/components/TopBar"
import { openSource } from "@/lib/h5j"
import { ingestH5J } from "@/lib/ingest"
import { clearAllDatasets, requestPersist, storageEstimate } from "@/lib/opfs"
import {
  basenameOf,
  NO_PARAMS,
  parseParams,
  serializeParams,
  visibleIndices,
} from "@/lib/url"
import {
  channelPicked,
  clearFinished,
  colorChanged,
  opacityChanged,
  volumeRenderingToggled,
  projectionSamplesChanged,
  launchParsed,
  clearStarted,
  settingsOpened,
  persistResult,
  visibilityChanged,
  sourceFailed,
  sourceOpened,
  sourceOpening,
  storageUpdated,
} from "@/state/actions"
import { useAppState, useDispatch } from "@/state/context"
import { initialControls } from "@/state/reducer"
import { pickedChannel, projectedBytes } from "@/state/selectors"
import type { DragEvent } from "react"
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
  const picked = pickedChannel(state)

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
      name = source.name
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
            launch,
          },
          dispatch
        )
      } finally {
        refreshStorage()
      }
    },
    [controls, dispatch, launch, refreshStorage, source.info, source.name]
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
      const info = await onSelectSource(file)
      if (!info) return
      await onIngest(info, initialControls(info, NO_PARAMS), file.name)
    },
    [onIngest, onSelectSource]
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
      const info = await onSelectSource(params.h5jUrl!)
      if (!info) return
      // SOURCE_OPENED has already built these, but the reducer's result is not
      // readable until the next render, so derive them again rather than starting the
      // conversion a render late.
      await onIngest(
        info,
        initialControls(info, params),
        basenameOf(params.h5jUrl!)
      )
    })()
  }, [dispatch, onIngest, onSelectSource])

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
        zoom: camera.zoom ?? launch.zoom,
      })
      history.replaceState(null, "", `${location.pathname}${search}`)
    }, URL_WRITE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [
    camera.position,
    camera.zoom,
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

  // Picking also reveals: the eye and swatch are the only reason to pick a channel, and
  // editing one that cannot be seen is a dead end.
  const onPick = useCallback(
    (index: number) => {
      dispatch(channelPicked(index))
      if (controls.visible[index] === false) {
        dispatch(
          visibilityChanged(
            controls.visible.map((shown, i) =>
              i === index ? true : shown !== false
            )
          )
        )
      }
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
        convertingIndex={ingest.channelIndex}
        fraction={ingest.fraction}
        phase={ingest.phase}
        warnings={ingest.warnings}
        error={ingest.error}
        picked={picked}
        pickedOpacity={picked ? (controls.opacity[picked.index] ?? 1) : 1}
        sourceName={source.name}
        sourceUrl={source.h5jUrl}
        volumeRendering={controls.volumeRendering}
        onVolumeRenderingChange={(on) => dispatch(volumeRenderingToggled(on))}
        projectionSamples={controls.projectionSamples}
        onProjectionSamplesChange={(samples) =>
          dispatch(projectionSamplesChanged(samples))
        }
        onToggleVisibility={onToggleVisibility}
        onPick={onPick}
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
        onClearAll={onClear}
        clearing={storage.clearing}
      />
    </div>
  )
}

/** Debounce for address-bar updates; pose changes will be continuous once wired up. */
const URL_WRITE_DELAY_MS = 300
