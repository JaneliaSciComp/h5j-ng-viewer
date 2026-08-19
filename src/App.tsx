import { useCallback, useEffect, useRef, useState } from "react"
import { NeuroglancerViewer } from "@janelia/react-neuroglancer"
import { ChannelList } from "@/components/ChannelList"
import { Dialog } from "@/components/Dialog"
import { IngestProgress } from "@/components/IngestProgress"
import { SourcePicker } from "@/components/SourcePicker"
import { StorageStatus } from "@/components/StorageStatus"
import {
  decodeChannel,
  defaultChannelColors,
  openSource,
  projectedOutputBytes,
  resolveDims,
} from "@/lib/h5j"
import { buildViewerState } from "@/lib/ngstate"
import { syntheticVolume } from "@/lib/synthetic"
import { clearAllDatasets, requestPersist, storageEstimate } from "@/lib/opfs"
import type {
  BitDepth,
  H5JInfo,
  IngestMessage,
  IngestPhase,
  IngestRequest,
  ResolvedDims,
} from "@/types"
import type { ChannelStats } from "@/lib/stats"
import type { H5JFile } from "@janelia/web-h5j-loader"

type Phase = IngestPhase | "decoding" | "idle"

export function App() {
  const fileRef = useRef<H5JFile | null>(null)
  const [info, setInfo] = useState<H5JInfo | null>(null)
  const [sourceName, setSourceName] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [bits, setBits] = useState<BitDepth>(16)

  const [phase, setPhase] = useState<Phase>("idle")
  const [fraction, setFraction] = useState<number | null>(null)
  const [channelLabel, setChannelLabel] = useState<string>()
  const [detail, setDetail] = useState<string>()
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const [viewerState, setViewerState] = useState<string | null>(null)
  const [datasetId, setDatasetId] = useState<string | null>(null)

  const [storage, setStorage] = useState({ usage: 0, quota: 0 })
  const [persisted, setPersisted] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [loadOpen, setLoadOpen] = useState(true)
  const [geometry, setGeometry] = useState<string | null>(null)
  const [channelStats, setChannelStats] = useState<string[]>([])

  const busy = phase !== "idle" && phase !== "done"

  const refreshStorage = useCallback(() => {
    storageEstimate().then(setStorage, () => undefined)
  }, [])

  useEffect(() => {
    refreshStorage()
    requestPersist().then(setPersisted, () => setPersisted(false))
  }, [refreshStorage])

  const onSelectSource = useCallback(async (src: File | string) => {
    setError(null)
    setWarnings([])
    setInfo(null)
    setSelected([])
    setViewerState(null)
    setDatasetId(null)
    setPhase("idle")
    setFraction(null)
    setDetail("Reading container")
    try {
      const { file, info: parsed } = await openSource(src)
      fileRef.current = file
      setInfo(parsed)
      setSourceName(typeof src === "string" ? src : src.name)
      // Pre-select everything: single-channel files are the common case and the
      // extra click is pure friction.
      setSelected(parsed.channels.map((channel) => channel.name))
      setDetail(undefined)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
      setDetail(undefined)
    }
  }, [])

  const onIngest = useCallback(async () => {
    const file = fileRef.current
    if (!file || !info || selected.length === 0) return

    const id = makeDatasetId(sourceName)
    const colors = defaultChannelColors(info.channelSpec, selected.length)
    const collectedWarnings: string[] = []

    setError(null)
    setWarnings([])
    setDatasetId(null)
    setViewerState(null)

    // Resolved once, from the first channel, and reused. Every channel of one H5J
    // file shares the `Channels` group's width/height/frames, and the whole dataset
    // shares a single .zarray -- so letting each channel resolve its own geometry
    // would risk later channels silently redefining the shape that earlier channels'
    // already-written chunks are read against.
    let dims: ResolvedDims | null = null
    const stats: Array<ChannelStats | undefined> = []

    try {
      for (let index = 0; index < selected.length; index += 1) {
        const name = selected[index]
        setChannelLabel(`${name} (${index + 1} of ${selected.length})`)

        setPhase("decoding")
        setFraction(0)
        // Decoding runs here, on the main thread, because ffmpeg.wasm 0.10 injects a
        // <script> tag and so cannot run in a worker. It is the long pole, hence the
        // per-channel progress ratio.
        const decoded = await decodeChannel(file, name, bits, setFraction)

        if (!dims) {
          dims = resolveDims(info, decoded.length)
          if (dims.warnings.length > 0) {
            collectedWarnings.push(...dims.warnings)
            setWarnings([...collectedWarnings])
          }
        } else if (decoded.length !== dims.padX * dims.padY * dims.size.z) {
          throw new Error(
            `Channel "${name}" decoded to ${decoded.length} voxels, but ` +
              `"${selected[0]}" decoded to ${dims.padX * dims.padY * dims.size.z}. ` +
              `Channels of one file must share a geometry.`
          )
        }

        const request: IngestRequest = {
          datasetId: id,
          datasetName: sourceName || id,
          channelIndex: index,
          channelCount: selected.length,
          channelNames: selected,
          channelColors: colors,
          bits,
          dims,
          data: detachBuffer(decoded),
        }

        setPhase("chunking")
        setFraction(0)
        await runIngest(request, (message) => {
          if (message.type === "phase") {
            setPhase(message.phase)
            setDetail(
              message.levelCount > 1
                ? `Level ${message.level} of ${message.levelCount - 1}`
                : undefined
            )
          } else if (message.type === "progress") {
            setFraction(message.fraction)
          } else if (message.type === "stats") {
            stats[message.channelIndex] = message.stats
          }
        })

        // Mount the viewer as soon as the first channel is readable. Later channels
        // stream in underneath: zarr reads a not-yet-written chunk as fill_value.
        if (index === 0) {
          setDatasetId(id)
          setGeometry(
            `${dims.size.x}×${dims.size.y}×${dims.size.z}, ` +
              `${selected.length} channel${selected.length === 1 ? "" : "s"}, ${bits}-bit`
          )
          setViewerState(
            JSON.stringify(
              buildViewerState({
                origin: location.origin,
                datasetId: id,
                datasetName: sourceName || id,
                channelNames: selected,
                channelColors: colors,
                voxelSize: dims.voxelSize,
                size: dims.size,
                bits,
                channelRanges: contrastRanges(stats, selected.length),
              })
            )
          )
        }

        const measured = stats[index]
        if (measured) {
          // Surfaced because an all-zero channel and a correctly-converted but dim one
          // look identical in the viewer.
          setChannelStats((previous) => [
            ...previous,
            `${name}: ${measured.min}–${measured.max}, ` +
              `display ${measured.lower}–${measured.upper}, ` +
              `${(measured.nonZeroFraction * 100).toFixed(1)}% non-zero`,
          ])
          if (measured.max === 0) {
            collectedWarnings.push(
              `Channel "${name}" decoded to all zeros, so it will render as nothing.`
            )
            setWarnings([...collectedWarnings])
          }
        }
      }

      setPhase("done")
      setFraction(null)
      setChannelLabel(undefined)
      setDetail(undefined)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
      setPhase("idle")
      setFraction(null)
    } finally {
      refreshStorage()
    }
  }, [bits, info, refreshStorage, selected, sourceName])

  // Milestone 2 gate, kept in the shipped UI because it is also the fastest way to
  // tell a broken service worker apart from a broken H5J decode.
  const onSynthetic = useCallback(async () => {
    const volume = syntheticVolume(bits)
    const id = makeDatasetId(volume.name)
    const names = ["synthetic"]
    const colors = ["#ffffff"]

    setError(null)
    setWarnings([])
    setViewerState(null)
    setDatasetId(null)
    setChannelLabel(volume.name)

    try {
      setPhase("chunking")
      setFraction(0)
      await runIngest(
        {
          datasetId: id,
          datasetName: volume.name,
          channelIndex: 0,
          channelCount: 1,
          channelNames: names,
          channelColors: colors,
          bits,
          dims: volume.dims,
          data: detachBuffer(volume.data),
        },
        (message) => {
          if (message.type === "phase") setPhase(message.phase)
          else if (message.type === "progress") setFraction(message.fraction)
        }
      )
      setDatasetId(id)
      setViewerState(
        JSON.stringify(
          buildViewerState({
            origin: location.origin,
            datasetId: id,
            datasetName: volume.name,
            channelNames: names,
            channelColors: colors,
            voxelSize: volume.dims.voxelSize,
            size: volume.dims.size,
            bits,
          })
        )
      )
      setPhase("done")
      setFraction(null)
      setChannelLabel(undefined)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
      setPhase("idle")
      setFraction(null)
    } finally {
      refreshStorage()
    }
  }, [bits, refreshStorage])

  const onClear = useCallback(async () => {
    setClearing(true)
    try {
      await clearAllDatasets()
      setViewerState(null)
      setDatasetId(null)
      setPhase("idle")
    } finally {
      setClearing(false)
      refreshStorage()
    }
  }, [refreshStorage])

  const projected =
    info && selected.length > 0 && !viewerState
      ? projectedOutputBytes(info.nominalSize, selected.length, bits)
      : null

  return (
    <div className="app">
      <header className="topbar">
        <h1>H5J → Neuroglancer</h1>
        <span className="topbar-dataset" title={sourceName || undefined}>
          {datasetId ? sourceName || datasetId : "No data loaded"}
        </span>
        {geometry ? (
          <span
            className="topbar-geometry"
            title={channelStats.join("\n") || undefined}
          >
            {geometry}
          </span>
        ) : null}
        <IngestProgress
          compact
          phase={phase}
          fraction={fraction}
          channelLabel={channelLabel}
          detail={detail}
          warnings={warnings}
          error={error}
          details={channelStats}
        />
        <button
          type="button"
          className="primary"
          onClick={() => setLoadOpen(true)}
        >
          Load data…
        </button>
      </header>

      <main className="viewer-area">
        {viewerState && datasetId ? (
          <NeuroglancerViewer
            key={datasetId}
            initialState={viewerState}
            className="ng"
            width="100%"
            height="100%"
          />
        ) : (
          <p className="placeholder">
            Choose an H5J file to convert and view. Nothing is uploaded —
            decoding and conversion happen in this tab.
          </p>
        )}
      </main>

      <Dialog
        open={loadOpen}
        title="Load data"
        onClose={() => setLoadOpen(false)}
      >
        <SourcePicker onSelect={onSelectSource} disabled={busy} />

        {info && (
          <>
            <ChannelList
              channels={info.channels}
              selected={selected}
              onChange={setSelected}
              bits={bits}
              onBitsChange={setBits}
              colors={defaultChannelColors(info.channelSpec, selected.length)}
              disabled={busy}
            />
            <button
              type="button"
              className="primary"
              onClick={() => {
                setLoadOpen(false)
                void onIngest()
              }}
              disabled={busy || selected.length === 0}
            >
              {busy ? "Converting…" : "Convert and view"}
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => {
            setLoadOpen(false)
            void onSynthetic()
          }}
          disabled={busy}
          title="Ingest a generated volume, bypassing H5J decoding"
        >
          Load synthetic test volume
        </button>

        <StorageStatus
          usage={storage.usage}
          quota={storage.quota}
          projected={projected}
          persisted={persisted}
          onClear={onClear}
          clearing={clearing}
        />
      </Dialog>
    </div>
  )
}

/**
 * Run one channel through the ingest worker. A fresh worker per channel keeps the
 * message protocol a plain request/response with no routing state, and guarantees the
 * decoded buffer is released when the worker is terminated.
 */
function runIngest(
  request: IngestRequest,
  onMessage: (message: IngestMessage) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./ingest.worker.ts", import.meta.url), {
      type: "module",
    })
    const finish = (settle: () => void) => {
      worker.terminate()
      settle()
    }
    worker.onmessage = (event: MessageEvent<IngestMessage>) => {
      const message = event.data
      onMessage(message)
      if (message.type === "done") finish(resolve)
      else if (message.type === "error")
        finish(() => reject(new Error(message.message)))
    }
    worker.onerror = (event) =>
      finish(() => reject(new Error(event.message || "Ingest worker failed")))
    worker.postMessage(request, [request.data])
  })
}

/**
 * Hand the decoder's output to the worker as a transferable ArrayBuffer. ffmpeg's
 * emscripten FS may return a view into a larger buffer, in which case transferring the
 * whole buffer would move more than we own -- copy in that case.
 */
function detachBuffer(array: Uint8Array | Uint16Array): ArrayBuffer {
  const exact =
    array.byteOffset === 0 && array.byteLength === array.buffer.byteLength
  return exact
    ? (array.buffer as ArrayBuffer)
    : (array.slice().buffer as ArrayBuffer)
}

/**
 * Per-channel display ranges from the measured statistics, in c-axis order. Channels
 * still being ingested get no entry, so buildViewerState falls back to the dtype range
 * for them rather than inventing a window.
 */
function contrastRanges(
  stats: Array<ChannelStats | undefined>,
  count: number
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < count; index += 1) {
    const measured = stats[index]
    if (measured && measured.upper > measured.lower) {
      ranges[index] = [measured.lower, measured.upper]
    }
  }
  return ranges
}

function makeDatasetId(sourceName: string): string {
  const base =
    sourceName
      .replace(/^.*[/\\]/, "")
      .replace(/\.h5j$/i, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 60) || "volume"
  return `${base}-${Date.now().toString(36)}`
}
