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
_root_ stores it has are `http://`, `gs://` and `s3://` — there is no in-memory or
local-file store. So to feed it client-side data without modifying it, we give it
something that looks like an HTTP server: a service worker that synthesizes responses
from data in the Origin Private File System.

This works because Neuroglancer fetches chunks from a dedicated module worker, and a
dedicated worker spawned by a controlled page is itself a service-worker client, so its
requests are intercepted too.

Data is pre-chunked at ingest time — one packed file per pyramid level per channel,
with chunks laid out in zarr chunk-grid order. The service worker turns a chunk key
into a byte offset with a single multiply and holds no state, so it can be terminated
and restarted freely.

## Requirements

- A Chromium-based browser. This relies on OPFS (including from a service worker),
  `SharedArrayBuffer`, and WebGL 2.
- Node 22+ and pnpm.

## Development

```bash
pnpm install
pnpm dev      # http://localhost:3000
```

```bash
pnpm test     # vitest, unit tests for the pure conversion logic
pnpm lint     # eslint + tsc
pnpm build    # production bundle into dist/
pnpm preview  # serve dist/ with the required headers
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

Without them you get `SharedArrayBuffer is not defined`. `vite.config.ts` sets these
for `pnpm dev` and `pnpm preview`; a production host must be configured to match.
`../flyefish-web/nginx.conf` is a working example — note its comment about `add_header`
in nested `location` blocks silently dropping inherited headers.

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

- The decoded buffer is **padded** — H.265 needs aligned frames — and the H5J `frames`
  attribute can disagree with reality. `resolveDims` in `src/lib/h5j.ts` reconciles both
  against the actual decoded voxel count rather than trusting the metadata.
- H5J `image_size` holds **voxel counts, not physical extent**, despite the name. Voxel
  size comes from `voxel_size` only; when it is missing the viewer says so rather than
  silently showing a squashed volume.
- The 16-bit path returns the original **12-bit** values unscaled, so the shader's
  contrast range is `[0, 4095]` — not `[0, 65535]`.
