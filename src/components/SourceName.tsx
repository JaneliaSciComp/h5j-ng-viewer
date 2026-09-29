import type { ReactElement } from "react"

/**
 * The name of the loaded file: the only thing on screen that says which file is open,
 * since Neuroglancer's layers are named per channel.
 *
 * Elided at the END, and capped narrow, so the per-channel controls to its right keep the
 * width. The head of these names is what identifies them -- "R80A07-20190611_64_A2-…" --
 * so keeping the front and dropping the tail loses the least; the full name and its source
 * URL are on hover, and the untruncated name also sits in Settings.
 *
 * A single span with `text-overflow: ellipsis` does the whole job at any width, so there
 * is nothing to measure and no re-render on a window drag.
 */
export function SourceName(props: {
  /** The file's name; empty before anything is loaded. */
  name: string
  /** Where it came from, or null for a local file. Shown on hover when present. */
  url: string | null
}): ReactElement | null {
  if (!props.name) return null

  return (
    <span
      className="bar-source"
      title={props.url ? `${props.name}\n${props.url}` : props.name}
    >
      {props.name}
    </span>
  )
}
