// Action-type constants, mirroring Clio's `src/reducers/constants.js` so the layout is
// familiar: `import C from "@/state/constants"` then `C.SOURCE_OPENED`.
//
// String values match their keys, which makes them readable in a debugger and means a
// typo in the value cannot silently create a second, unhandled action type.

const C = {
  // What the address bar asked for, parsed once at startup.
  LAUNCH_PARSED: "LAUNCH_PARSED",

  // Opening an H5J container (no decoding yet).
  SOURCE_OPENING: "SOURCE_OPENING",
  SOURCE_OPENED: "SOURCE_OPENED",
  SOURCE_FAILED: "SOURCE_FAILED",

  // Which channels are shown. Not which are converted: every channel is.
  VISIBILITY_CHANGED: "VISIBILITY_CHANGED",

  COLOR_CHANGED: "COLOR_CHANGED",
  OPACITY_CHANGED: "OPACITY_CHANGED",

  // Whether the 3D panel projects the volume, and how finely. One choice for the whole
  // view each, not per channel, but rendering properties all the same.
  VOLUME_RENDERING_TOGGLED: "VOLUME_RENDERING_TOGGLED",
  PROJECTION_SAMPLES_CHANGED: "PROJECTION_SAMPLES_CHANGED",

  // Which channel the bar's eye and color swatch act on. UI focus, not a rendering
  // property, so it is deliberately not part of `controls` and not undoable.
  CHANNEL_PICKED: "CHANNEL_PICKED",

  // Conversion, from first decode to the post-ingest probe.
  INGEST_STARTED: "INGEST_STARTED",
  INGEST_CHANNEL: "INGEST_CHANNEL",
  INGEST_PHASE: "INGEST_PHASE",
  INGEST_PROGRESS: "INGEST_PROGRESS",
  INGEST_DIMS: "INGEST_DIMS",
  INGEST_STATS: "INGEST_STATS",
  CHANNEL_READY: "CHANNEL_READY",
  INGEST_WARNINGS: "INGEST_WARNINGS",
  INGEST_DETAILS: "INGEST_DETAILS",
  INGEST_DONE: "INGEST_DONE",
  INGEST_FAILED: "INGEST_FAILED",

  // The viewer can mount as soon as one channel is readable; later channels stream in
  // underneath because zarr reads a not-yet-written chunk as fill_value.
  VIEWER_READY: "VIEWER_READY",

  // Storage and chrome.
  STORAGE_UPDATED: "STORAGE_UPDATED",
  PERSIST_RESULT: "PERSIST_RESULT",
  CLEAR_STARTED: "CLEAR_STARTED",
  CLEAR_FINISHED: "CLEAR_FINISHED",
  // Reported by the viewer as the user navigates, so a link can say where to look.
  CAMERA_MOVED: "CAMERA_MOVED",

  SETTINGS_OPENED: "SETTINGS_OPENED",
} as const

export default C
