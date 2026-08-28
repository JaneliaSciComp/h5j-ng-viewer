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

`pos` and `zoom` are written back as you navigate, so a reload or a copied link reopens
the same view. Dragging a local `.h5j` onto the viewer also works, but a dropped file has
no URL, so that session is not shareable.

### The bar, left to right

**File name**, middle-elided so both the identifying front and the extension survive.
Hover for the full name and source URL.

**One chip per channel**, labeled with its index. Three independent visual channels
carry five states, so load status, visibility and edit target never compete for the same
cue:

| Chip                                  | Meaning                                      |
| ------------------------------------- | -------------------------------------------- |
| Dashed, dimmed                        | queued for conversion; inert                 |
| Dashed, with a filling ring around it | converting now, the ring showing progress    |
| Solid outline in the channel's color | converted, hidden                            |
| Filled with the channel's color      | converted, visible                           |
| Any of the above, plus an outer ring  | the channel the controls to the right act on |

Color is never the only indicator: filled-versus-hollow and dashed-versus-solid are shape
cues too. The conversion ring advances with the data rather than animating, so there is
nothing for `prefers-reduced-motion` to suppress.

Left-click toggles visibility, right-click picks the channel to edit, the same
convention as Neuroglancer's own layer panel. Every chip's tooltip names what the next
click will do rather than describing the control.

**Conversion readout**: phase and percentage while a channel converts; afterwards, a
warning count if anything was worth flagging. Click it to open the details.

**Eye, opacity slider, color swatch**: these act on the picked channel. The swatch
opens a color panel: eight presets from the Turbo colormap, then a full picker
(saturation/value square, hue slider, RGB sliders, hex field) so a custom color is one
click away rather than behind a browser dialog.

**3D checkbox and detail slider**: turns the 3D panel from three intersecting section
planes into a maximum-intensity projection of the volume, which is what Fiji's 3D
projection shows. Off by default because it raycasts. The slider sets how finely the
projection samples: left is cheapest, right is finer and costs proportionally more.

**Gear**: source URL, storage used and available, "delete all cached data", and the
per-channel intensity measurements and post-conversion probe results.

Every control applies immediately and there is nothing to confirm. Changes are surgical:
they reach the live Neuroglancer layer through its own accessors, so adjusting a color
or hiding a channel never moves the camera.

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
the single source of truth every layer is derived from, so a late-arriving c ontrast
measurement is _folded into_ it rather than rebuilt around it; rebuilding would discard
whatever the user changed meanwhile.

`ViewerPane` connects the store to the mounted viewer with two wires that run in opposite
directions and never meet:

```
controls  ──> buildLayer ──> live layer accessors      what the user changes in the bar
camera    ──> snapshot   ──> store ──> address bar     where the user has navigated to
```

Keeping each one-way is what prevents a feedback loop: the push reacts to `controls`,
which the snapshot never writes, and the pull reacts to the snapshot, which the push
never reads.

Nothing pushes whole viewer state after mount. Every change is applied to the layer
Neuroglancer already has, through the accessor for that specific property —
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
