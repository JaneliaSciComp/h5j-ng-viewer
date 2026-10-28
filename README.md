# h5j-ng-viewer

Loads an [H5J](https://github.com/JaneliaSciComp/workstation/blob/master/docs/H5JFileFormat.md)
file in the browser, converts it to OME-Zarr, and views it in Neuroglancer.

**There is no backend and no upload.** The file is decoded, converted and served
entirely inside the tab.

## How it works

```
H5J file ──> ffmpeg.wasm (H.265) ──> OME-Zarr chunks in OPFS ──> service worker ──> Neuroglancer
             main thread              ingest.worker.ts            sw.js              react-neuroglancer
```

Neuroglancer can only read data through its key-value store drivers, and the only
_root_ stores it has are `http://`, `gs://` and `s3://`; there is no in-memory or
local-file store. So to feed it client-side data without modifying it, we give it
something that looks like an HTTP server: a service worker that synthesizes responses
from data in the Origin Private File System.

This works because Neuroglancer fetches chunks from a dedicated module worker, and a
dedicated worker spawned by a controlled page is itself a service-worker client, so its
requests are intercepted too.

Data is pre-chunked at ingest time: one packed file per pyramid level per channel,
with chunks laid out in zarr chunk-grid order. The service worker turns a chunk key
into a byte offset with a single multiply and holds no state, so it can be terminated
and restarted freely.

## User interface

Neuroglancer gets the whole window; everything this app adds is one slim bar above it.
The bar gives quick access to some key functionality: mainly per-channel
rendering, which Neuroglancer expresses as one layer per channel with its own shader.
For everything about _navigating_ the volume, Neuroglancer's own controls and
documentation apply unchanged:

- [Neuroglancer's README](https://github.com/google/neuroglancer#readme): mouse and
  keyboard bindings, layer panel, shader language
- Press `h` in the viewer for the built-in key binding help

### Opening a file

The file to view comes from the address bar, so a link is the unit of sharing:

```
https://<host>/?h5j=<url-encoded H5J URL>&chs=0,1
```

| Parameter | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `h5j`     | The H5J to load. Must be CORS-readable: the browser fetches it directly        |
| `chs`     | Which channels start visible, e.g. `0,2`. Every channel is converted regardless |
| `col`     | Per-channel color override as `#rrggbb`, positional                            |
| `pos`     | Initial voxel position                                                          |
| `zoom`    | Initial cross-section scale, in voxels per pixel                                |
| `title`   | Text shown in the bar in place of the file name (the file name stays on hover)  |

`pos` is written back as you navigate, so a reload or a copied link reopens the same
place. `zoom` is written back only once you zoom yourself: on load the XY view is fitted
to its pane, and an untouched fit is left out of the address bar so a plain reload fits
again. A link that carries `zoom` opens at that zoom instead of fitting.

Dragging a local `.h5j` onto the viewer also works, but a dropped file has no URL, so
that session is not shareable.

### The bar, left to right

**File name** (or the `title` parameter, when given), elided at the end and given at most
a quarter of the bar, so the channel controls keep their room. Hover for the full name and
source URL.

**Conversion readout**: the phase and percentage of work that belongs to no single
channel (fetching the file, reclaiming storage), and afterwards a warning count if
anything was worth flagging. Click it to open the details. It stays empty while a channel
converts, because each channel shows its own progress.

**One box per channel**, each holding that channel's own controls, so every control sits
under the channel it acts on:

- **`Ch N`**, the channel's 0-based index, matching `chs` and the container's own
  `Channel_N` names.
- **Eye**: shows or hides the channel.
- **Color swatch**: opens a color panel with eight presets from the Turbo colormap, then a
  full picker (saturation/value square, hue slider, RGB sliders, hex field), so a custom
  color is one click away rather than behind a browser dialog.
- **Opacity slider**.

A channel that has not finished converting keeps its box, with its controls disabled and
a progress bar along the bottom that fills as it converts; channels waiting their turn
show an empty bar. The bar advances with the data rather than animating, so there is
nothing for `prefers-reduced-motion` to suppress. Tooltips on a disabled control say how
far that channel has got.

Default colors are magenta and green for a two-channel file, and colors from the Turbo
palette otherwise; `col` overrides either.

**Z slider**: shows which slice the cross-section views are on, and moves through them,
the same as the mouse wheel over the XY view. Only depth changes; the in-plane position
and the zoom stay where they are.

**Memory**: how much of the storage limit is in use, with a hatched segment for what the
conversion in flight still needs. Hover for the figures.

**Gear**: source URL, storage used against the limit, the storage settings, "delete all
cached data", and the per-channel intensity measurements and post-conversion probe
results.

### Storage

Converted volumes are large (an 11 MB H5J becomes roughly 1.3 GB), so the app keeps
them within a limit:

- **A cap in gigabytes**, 20 GB by default, set in Settings.
- **Never more than half of the browser's quota.** The quota shrinks as the disk fills,
  so on a nearly full disk this takes over from the cap; Settings says when it has.
- **Trimmed every time the app opens**, not only when a new file needs room: unfinished
  leftovers first, then volumes not opened for 14 days, then the least recently opened
  until within the limit.
- **Volumes in use are never removed**, including one on screen or converting in another
  tab of the same site.

Storage is **not** marked persistent unless you tick "Keep converted volumes even when
the disk is low" in Settings. Left unpersisted, the browser can clear the app's data
itself when the disk runs low. That's the only thing that ever cleans up an origin the
app is no longer opened on.

Each origin (`http://localhost:3000`, `https://<host>:3000`, a deployment) keeps its own
separate store, and the gear only sees its own. To see or clear all of them, sort by
data stored at `chrome://settings/content/all`.

Every control applies immediately and there is nothing to confirm. Changes are surgical:
they reach the live Neuroglancer layer through its own accessors, so adjusting a color
or hiding a channel never moves the camera.

The bar and Neuroglancer stay in step in both directions. Neuroglancer opens with its
**All controls** tool palette showing, and a channel's color, visibility or opacity
changed there (or in its layer panel) is reflected in the bar straight away.

### One array per channel, one layer per channel

Each channel is a separate three-dimensional zarr array under
`zarr/<dataset>/c<i>/`, and each becomes its own Neuroglancer image layer with
`blend: "additive"`.

The obvious alternative — one array with a channel axis, one layer, one shader looping
over channels — was tried first and had to be abandoned. Declaring `c^` in
`channelDimensions` requires the channel axis to map to a _single_ chunk, so `chunks[0]`
must equal `shape[0]`, so every chunk spans every channel. Such a chunk is only correct
once the **last** channel has written into it. Show the first channel while the second is
still converting and Neuroglancer fetches chunks whose later channels are still zeros,
caches them, and never re-fetches, so the second channel arrives with permanent
rectangular holes at chunk boundaries, and no error anywhere.

Splitting by channel has the following advantages:

- **The viewer mounts on the first converted channel**, not the last. Each remaining
  channel becomes visible by itself as it lands.
- **Chunk size stops scaling with channel count**: 512 KB at 16-bit, always.
- **Ingest appends sequentially** instead of writing at a stride into a chunk it cannot
  finish, so the reservation and offset arithmetic that existed only for the shared-chunk
  layout are gone.

The safety of the first point rests on one measured fact: Neuroglancer does not fetch
chunks for a layer that is not visible (verified empirically with test code). So a channel still being written is declared as a layer (it must be: a layer whose `.zattrs` 404s fails to resolve and never retries) but not made visible, and nothing incomplete is ever read.

## Implementation details

### Application framework

React 19 with `@janelia/react-neuroglancer`, which mounts a stock Neuroglancer build and
hands back a viewer handle. State is `useReducer` plus context; no Redux, no state
library:

```
src/state/     constants.ts  actions.ts  reducer.ts  selectors.ts  store.tsx  context.ts
```

The reducer is a pure function of `(state, action)`. That is worth stating because the
alternative is common and costly: a reducer that reads or writes anything outside its
arguments makes state changes order-dependent and undo intractable. `state.controls` is
the single source of truth every layer is derived from, so a late-arriving contrast
measurement is _folded into_ it rather than rebuilt around it; rebuilding would discard
whatever the user changed meanwhile.

`ViewerPane` connects the store to the mounted viewer:

```
controls  ──> buildLayer ──> live layer accessors        what the user changes in the bar
snapshot  ──> color, visibility, opacity ──> controls    what the user changes in Neuroglancer
snapshot  ──> camera ──> address bar                     where the user has navigated to
Z slider  ──> camera ──> viewer.state.restoreState       a slice chosen from the bar
```

Two rules keep these from feeding back into each other:

- **The read-back runs only when the snapshot changes**, never when the controls do. Run
  on a control change, it would compare the bar's new value against a snapshot taken
  before that value reached Neuroglancer, and revert it.
- **Every value read back is recorded as already pushed**, so the push sees nothing new
  and does not send it straight back. That matters beyond tidiness: a shader-control push
  restores every control at once, so an echoed color would also undo a contrast just set
  in the same Neuroglancer panel.

The Z slider sets a pending position that only it writes, and that is cleared once
applied, so a camera snapshot can never be mistaken for a scrub.

Nothing pushes whole viewer state after mount. Camera changes go through
`viewer.state.restoreState`, which is a _partial_ restore: it only touches the keys it is
given, so `{ position }` or `{ crossSectionScale }` moves the camera and leaves the layers
and the coordinate space alone. The wrapper's own `setState` is not used for this; it
rebuilds the coordinate space.

Layer changes work the same way: each is applied to the layer Neuroglancer already has,
through the accessor for that specific property —
`setVisible`, `opacity.value`, `shaderControlState.restoreState`,
`volumeRenderingMode.restoreState`. This is not a micro-optimization: replacing a layer
makes Neuroglancer re-resolve its data source and rebuild the coordinate space, which
comes back with no `dimensions` at all, and both view scales come back multiplied by the
voxel size in meters. Measured on a real load, `crossSectionScale` went from 2.36 to
1.23e-6 and the whole view collapsed to a speck in one corner, silently.

## Requirements

- A Chromium-based browser (Chrome/Edge 108+). Firefox 111+ has the required APIs but
  is untested here; note that it disables service workers in Private Browsing. The app
  relies on OPFS (including from a service worker), `SharedArrayBuffer` and WebGL 2.
- Node 22+ and npm.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
npm run dev:https    # https://<this-host>:3000, reachable from other machines
```

### Secure context required

Service workers, OPFS and `SharedArrayBuffer` are all hidden by the browser outside a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
Only `https://` and `http://localhost` qualify; **`http://<ip>:3000` does not**, in any
browser. Because browsers signal this by simply not defining the API, the symptom is a
startup error claiming the browser lacks service worker support, which is misleading;
the app checks `isSecureContext` first so it can name the real cause.

To reach the dev server from another machine, pick one:

- **SSH tunnel**: nothing to configure, and the origin stays `localhost`:
  ```bash
  ssh -L 3000:localhost:3000 <this-host>   # then browse http://localhost:3000
  ```
- **`npm run dev:https`**: binds all interfaces with a self-signed certificate. The
  browser will warn once; accepting it yields a secure context.

The port is `strictPort`, so a clash fails instead of drifting to `:3001`. That matters
here because the service worker registration and its OPFS contents are keyed to the
origin, and a drifting port would leave a stale registration behind.

```bash
npm test     # vitest, unit tests for the pure conversion logic
npm run lint     # eslint + tsc
npm run build    # production bundle into dist/
npm run preview  # serve dist/ with the required headers
```

## Deployment constraints

Read this before hosting it anywhere.

### Cross-origin isolation is mandatory

`@janelia/web-h5j-loader` decodes H.265 with `ffmpeg.wasm`, which uses threads, which
need `SharedArrayBuffer`, which needs cross-origin isolation. **Every** response must
carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the app refuses to start and says so. `vite.config.ts` sets these for
`npm run dev` and `npm run preview`; a production host must be configured to match. `deploy/`
has a working nginx config, compose file and step-by-step guide; note its warning that
nginx's `add_header` does not inherit into a `location` block that sets one of its own,
which drops the isolation headers silently and only after a cache hit.

### The app must be served at the origin root

Neuroglancer's chunk worker is constructed from a build-time-baked **absolute** path:

```js
new Worker(new URL("/assets/chunk_worker.bundle-<hash>.js", import.meta.url), {
  type: "module",
})
```

So `base` must stay `/`, `@janelia/react-neuroglancer`'s bundled assets must be served
from `/assets/`, and the app cannot live under a sub-path. Hosting it at, say,
`/viewer/` makes the chunk worker 404 and the viewer silently loads nothing.

### The ffmpeg core is vendored

`ffmpeg.wasm` 0.10 defaults its `corePath` to unpkg.com, which cross-origin isolation
blocks. `@ffmpeg/core` is copied to `/ffmpeg-core/` at build time and passed explicitly
(see `src/lib/h5j.ts`). Do not use the loader's own `createFFmpegForEnv`.

## Notes on the data

- The decoded buffer is **padded** (H.265 needs aligned frames) and the H5J `frames`
  attribute can disagree with reality. `resolveDims` in `src/lib/h5j.ts` reconciles both
  against the actual decoded voxel count rather than trusting the metadata.
- H5J `image_size` holds **voxel counts, not physical extent**, despite the name. Voxel
  size comes from `voxel_size` only; when it is missing the viewer says so rather than
  silently showing a squashed volume.
- The 16-bit path returns the original **12-bit** values unscaled, so the shader's
  contrast range is `[0, 4095]`, not `[0, 65535]`.
