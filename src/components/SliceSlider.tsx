import type { ReactElement } from "react"

/**
 * A slider for the current Z slice, in the place the 3D projection controls used to sit.
 * It does two jobs at once: it says which slice the section view is on, and it scrubs
 * through depth without the mouse -- a keyboard- and touch-reachable alternative to
 * dragging in the viewer.
 *
 * The value is the Z voxel index Neuroglancer reports (`position[2]`), so it tracks the
 * mouse as well as driving it; the scrub writes only the depth back, leaving x and y where
 * they are. Disabled until both the depth and a reported position are known, since a scrub
 * needs the current x and y to preserve them.
 */
export function SliceSlider(props: {
  /** Current Z voxel index, or null before the viewer has reported a position. */
  z: number | null
  /** Number of Z slices at full resolution, or null before dims are known. */
  depth: number | null
  onScrub: (z: number) => void
}): ReactElement {
  const ready = props.z !== null && props.depth !== null && props.depth > 0
  const max = ready ? (props.depth as number) - 1 : 0
  const value = ready
    ? Math.min(Math.max(Math.round(props.z as number), 0), max)
    : 0

  return (
    <span className="slice-slider">
      <span className="slice-label">Z</span>
      <input
        type="range"
        className="slice-range"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={!ready}
        aria-label="Z slice"
        title={
          ready
            ? `Z slice ${value} of ${max}`
            : "Z slice — available once a volume is loaded"
        }
        onChange={(event) => props.onScrub(Number(event.target.value))}
      />
      {/* Fixed width and tabular figures so the controls beside it do not shift as the
          number changes width during a drag. */}
      <span className="slice-value">{ready ? value : "—"}</span>
    </span>
  )
}
