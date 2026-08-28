import type { ReactElement } from "react"
import { ChannelChips } from "@/components/ChannelChips"
import { ChannelControls } from "@/components/ChannelControls"
import { ProgressText } from "@/components/ProgressText"
import { SourceName } from "@/components/SourceName"
import {
  formatSamples,
  PROJECTION_SAMPLE_STEPS,
  samplesForStep,
  stepForSamples,
} from "@/lib/projection"
import type { Phase } from "@/state/actions"
import type { ChannelInfo } from "@/types"

/**
 * The entire user interface: one row above Neuroglancer, which gets everything else.
 *
 * Left to right, packed to the left and evenly spaced: the file's name, a chip per
 * channel, the conversion readout, the controls for the channel being edited, the 3D
 * projection toggle, and the gear. Nothing is pushed to the far edge -- the eye and swatch sit next to the chips
 * they act on, which is where the eye travels anyway.
 *
 * The name comes first because it says what everything to its right acts on, and it is
 * the only piece that shrinks. Settings still carries the full source URL.
 */
export function TopBar(props: {
  channels: ChannelInfo[]
  visible: boolean[]
  ready: boolean[]
  colors: string[]
  convertingIndex: number | null
  fraction: number | null
  phase: Phase
  warnings: string[]
  error: string | null
  picked: {
    index: number
    name: string
    visible: boolean
    color: string
  } | null
  pickedOpacity: number
  /** The file's name, and where it came from -- null for a dropped local file. */
  sourceName: string
  sourceUrl: string | null
  volumeRendering: boolean
  onVolumeRenderingChange: (on: boolean) => void
  projectionSamples: number
  onProjectionSamplesChange: (samples: number) => void
  onToggleVisibility: (index: number) => void
  onPick: (index: number) => void
  onColorChange: (index: number, color: string) => void
  onOpacityChange: (index: number, opacity: number) => void
  onOpenSettings: () => void
}): ReactElement {
  const hasData = props.channels.length > 0

  return (
    <header className="topbar">
      <SourceName name={props.sourceName} url={props.sourceUrl} />

      {hasData ? (
        <ChannelChips
          channels={props.channels}
          visible={props.visible}
          ready={props.ready}
          convertingIndex={props.convertingIndex}
          fraction={props.fraction}
          picked={props.picked?.index ?? null}
          colors={props.colors}
          onToggleVisibility={props.onToggleVisibility}
          onPick={props.onPick}
        />
      ) : null}

      <ProgressText
        phase={props.phase}
        fraction={props.fraction}
        warnings={props.warnings}
        error={props.error}
        onShowDetails={props.onOpenSettings}
      />

      {hasData ? (
        <ChannelControls
          channel={props.picked}
          opacity={props.pickedOpacity}
          onToggleVisibility={props.onToggleVisibility}
          onColorChange={props.onColorChange}
          onOpacityChange={props.onOpacityChange}
        />
      ) : null}

      {/* One switch for the whole view rather than one per channel: it turns the 3D
          panel from three intersecting planes into a projection of the volume, which is
          not a property of any single channel. Left unchecked by default because it
          raycasts, so it costs GPU time that a user looking at slices should not pay. */}
      <label
        className="bar-toggle"
        title={
          hasData
            ? "Project the volume in the 3D panel (maximum intensity) instead of showing only the section planes"
            : "Project the volume in the 3D panel — available once a file is loaded"
        }
      >
        <input
          type="checkbox"
          checked={props.volumeRendering}
          disabled={!hasData}
          onChange={(event) =>
            props.onVolumeRenderingChange(event.target.checked)
          }
          aria-label="Project the volume in the 3D panel"
        />
        3D
      </label>

      {/* Shown but disabled while the projection is off, rather than hidden: a control
          that appears only once something else is set is a control the user has to
          discover twice. */}
      <input
        type="range"
        className="bar-samples"
        min={0}
        max={PROJECTION_SAMPLE_STEPS.length - 1}
        step={1}
        value={stepForSamples(props.projectionSamples)}
        disabled={!hasData || !props.volumeRendering}
        onChange={(event) =>
          props.onProjectionSamplesChange(
            samplesForStep(Number(event.target.value))
          )
        }
        title={
          props.volumeRendering
            ? `3D detail: ${formatSamples(props.projectionSamples)} samples along each ray. Right is finer and costs proportionally more.`
            : "3D detail — available when 3D is checked"
        }
        aria-label="3D projection detail"
      />
      <span className="bar-samples-value">
        {props.volumeRendering ? formatSamples(props.projectionSamples) : "—"}
      </span>

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
