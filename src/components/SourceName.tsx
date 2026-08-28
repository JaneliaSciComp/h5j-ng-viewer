import type { ReactElement } from "react"
import { splitForMiddleElision } from "@/components/elideName"

/**
 * The name of the loaded file: the only thing on screen that says which file is open,
 * since Neuroglancer's layers are named per channel.
 *
 * Elided in the MIDDLE, not at the end, because these names carry their identity at both
 * ends and boilerplate between -- "R80A07-20190611_64_A2-m-40x-central-GAL4-JRC2018_
 * Unisex_20x_HR-aligned_stack.h5j". End-elision would cut off the extension and the
 * "-aligned_stack" that says what kind of file it is; start-elision would cut off the
 * line and sample that say which one.
 *
 * Done with two spans rather than by measuring text, because measuring means a
 * ResizeObserver, a hidden canvas or an off-screen clone, and a re-render on every drag
 * of the window edge. Here the head shrinks and ellipsizes on its own and the tail never
 * shrinks at all, so the browser's own layout does the whole job at any width.
 */
export function SourceName(props: {
  /** The file's name; empty before anything is loaded. */
  name: string
  /** Where it came from, or null for a local file. Shown on hover when present. */
  url: string | null
}): ReactElement | null {
  if (!props.name) return null

  const [head, tail] = splitForMiddleElision(props.name)
  return (
    <span
      className="bar-source"
      title={props.url ? `${props.name}\n${props.url}` : props.name}
    >
      <span className="bar-source-head">{head}</span>
      {tail ? <span className="bar-source-tail">{tail}</span> : null}
    </span>
  )
}
