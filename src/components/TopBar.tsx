import type { ReactElement } from "react"
import { ChannelStrip } from "@/components/ChannelStrip"
import { SliceSlider } from "@/components/SliceSlider"
import { ProgressText } from "@/components/ProgressText"
import { MemoryBar } from "@/components/MemoryBar"
import { SourceName } from "@/components/SourceName"
import type { Phase } from "@/state/actions"
import type { ChannelInfo } from "@/types"

/**
 * The entire user interface: one row above Neuroglancer, which gets everything else.
 *
 * Left to right: the file's name (which shrinks first, since it only labels the rest); a
 * readout for whole-file phases and any error or warning; one control group per channel --
 * label, eye, swatch, opacity; a Z-slice slider; and, hard right, storage and the gear.
 *
 * There is no "channel being edited" any more: every channel carries its own controls, so
 * the eye and swatch always sit under the channel they act on.
 */
export function TopBar(props: {
  channels: ChannelInfo[]
  visible: boolean[]
  ready: boolean[]
  colors: string[]
  opacity: number[]
  convertingIndex: number | null
  fraction: number | null
  phase: Phase
  /** What the current phase is working on, shown beside its label. */
  phaseDetail?: string
  warnings: string[]
  error: string | null
  /** The file's name, and where it came from -- null for a dropped local file. */
  sourceName: string
  sourceUrl: string | null
  /** Current Z voxel index, or null before the viewer has reported a position. */
  sliceZ: number | null
  /** Depth of the volume in voxels, or null before dims are known. */
  sliceDepth: number | null
  onScrub: (z: number) => void
  usage: number
  quota: number
  /** Projected size of the conversion in flight, or null when nothing is pending. */
  projected: number | null
  persisted: boolean
  evictionPercent: number
  onToggleVisibility: (index: number) => void
  onColorChange: (index: number, color: string) => void
  onOpacityChange: (index: number, opacity: number) => void
  onOpenSettings: () => void
}): ReactElement {
  const hasData = props.channels.length > 0

  return (
    <header className="topbar">
      <SourceName name={props.sourceName} url={props.sourceUrl} />

      <ProgressText
        phase={props.phase}
        fraction={props.fraction}
        detail={props.phaseDetail}
        channelIndex={props.convertingIndex}
        warnings={props.warnings}
        error={props.error}
        onShowDetails={props.onOpenSettings}
      />

      {hasData ? (
        <ChannelStrip
          channels={props.channels}
          visible={props.visible}
          ready={props.ready}
          colors={props.colors}
          opacity={props.opacity}
          convertingIndex={props.convertingIndex}
          fraction={props.fraction}
          onToggleVisibility={props.onToggleVisibility}
          onColorChange={props.onColorChange}
          onOpacityChange={props.onOpacityChange}
        />
      ) : null}

      {hasData ? (
        <SliceSlider
          z={props.sliceZ}
          depth={props.sliceDepth}
          onScrub={props.onScrub}
        />
      ) : null}

      <MemoryBar
        usage={props.usage}
        quota={props.quota}
        projected={props.projected}
        persisted={props.persisted}
        evictionPercent={props.evictionPercent}
      />

      <button
        type="button"
        className="icon-button"
        onClick={props.onOpenSettings}
        title="Settings and stored data"
        aria-label="Settings and stored data"
      >
        {/* A cog: eight trapezoidal teeth between a root and an outer circle, with the
            hub cut out by the even-odd rule. Drawn solid rather than stroked because a
            stroked outline of this many edges turns to mush at 15px. */}
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M18.81 8.17 L18.81 11.83 L15.99 12.26 L15.83 12.63 L17.52 14.94 L14.94 17.52 L12.63 15.83 L12.26 15.99 L11.83 18.81 L8.17 18.81 L7.74 15.99 L7.37 15.83 L5.06 17.52 L2.48 14.94 L4.17 12.63 L4.01 12.26 L1.19 11.83 L1.19 8.17 L4.01 7.74 L4.17 7.37 L2.48 5.06 L5.06 2.48 L7.37 4.17 L7.74 4.01 L8.17 1.19 L11.83 1.19 L12.26 4.01 L12.63 4.17 L14.94 2.48 L17.52 5.06 L15.83 7.37 L15.99 7.74 Z M13.10 10.00 A3.1 3.1 0 1 0 6.90 10.00 A3.1 3.1 0 1 0 13.10 10.00 Z"
          />
        </svg>
      </button>
    </header>
  )
}
