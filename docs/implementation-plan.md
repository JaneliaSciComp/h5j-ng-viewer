# Implementation Plan: H5J → OME-Zarr → Neuroglancer (browser-only)

Derived from `notes/h5j-neuroglancer-spec.md` plus findings from `../flyefish-web`,
`../web-h5j-loader`, `../web-vol-viewer`, and the unpacked
`@janelia/react-neuroglancer@0.0.1` tarball. Where this plan contradicts the spec,
the reason is recorded inline under **Spec delta**.

---

## 0. Verified facts that shape the design

These were checked against real artifacts, not assumed.

| # | Finding | Evidence |
|---|---|---|
| F1 | Neuroglancer's chunk worker is a **same-origin module worker**, not a `blob:` URL. Service-worker interception will work. | `dist/index.js`: `new Worker(new URL("/assets/chunk_worker.bundle-COc0o5e8.js", import.meta.url), { type: "module" })` |
| F2 | That path is **absolute** (`/assets/...`). The app must be served at origin root and the ng assets must land at `/assets/`. | same line as F1 |
| F3 | Base kvstore schemes are only `http`/`https`/`gs`/`s3` (plus derived `zip`, `ocdbt`, `icechunk`, `byte-range`). There is no in-memory root store. The service worker is genuinely required. | `scheme:` literals in `assets/chunk_worker.bundle-*.js` |
| F4 | Zarr v2 is selected by the **URL suffix `|zarr2:`**, not `zarr://`. Directory format matches on `.zarray`/`.zattrs`. | `registerDirectoryFormat(... new Set([".zarray",".zattrs"]), { suffix: "zarr2:" })` in `dist/index.js`; matches `flyefish-web/src/config/neuroglancer-base.json` |
| F5 | Neuroglancer issues `HEAD`, then a `range: bytes=0-0` size probe, then real ranged reads, and parses `Content-Range`. Range support in the SW is mandatory. | `bytes=${offset}-${offset+length-1}` and `headers:{range:"bytes=0-0"}` in the chunk worker bundle |
| F6 | **ffmpeg.wasm 0.10 cannot run in a Web Worker** — it injects a `<script>` tag. Decode must happen on the main thread. | `@ffmpeg/ffmpeg@0.10.1/src/browser/getCreateFFmpegCore.js` uses `document.createElement('script')` |
| F7 | ffmpeg's default `corePath` points at **unpkg.com**, which COEP `require-corp` will fight. Vendor the core and pass `corePath` explicitly. | `@ffmpeg/ffmpeg@0.10.1/src/browser/defaultOptions.js` |
| F8 | The decoded array is **padded**: width/height are rounded up to a multiple of 8. Real frame count comes from `byteLength`, because `frames` can be wrong. | `web-vol-viewer/src/Utils.js:72-75` (`alignment = 8`) and `:18-27` (`fixVolumeSize`) |
| F9 | Voxel order is `[z][y][x]`, x fastest. | `web-vol-viewer/src/Vol3dViewer.jsx:151` builds `DataTexture3D(data, volumeSize[0], volumeSize[1], volumeSize[2])` |
| F10 | H5J `image_size` is **voxel counts, not physical extent** — `parseH5jAttrs` overwrites it from `width`/`height`/`frames`. Spec §7's `image_size / [w,h,d]` fallback would always yield `[1,1,1]`. | `web-vol-viewer/src/Utils.js:45-71`; `web-h5j-loader/testData/w256h128d64.yml` has `image_size: [256,128,64]`, `voxel_size: [0.44,0.44,0.44]` |
| F11 | `readH5JChannelUint16` returns **12-bit values (0-4095)**, unscaled. Shader `invlerp` range must be `[0,4095]`, not `[0,65535]`. | `web-h5j-loader/README.md` "Accuracy"; `web-h5j-loader.js:200-202` |
| F12 | The loader tests `src instanceof global.File`. `global` is undefined under Vite (webpack shimmed it for web-vol-viewer). Needs `define: { global: 'globalThis' }`. | `web-h5j-loader/src/web-h5j-loader.js:53` |
| F13 | `NeuroglancerViewer` takes `initialState` as a **JSON string** and its effect has `[]` deps — it mounts once. Change datasets by remounting via `key`, or drive it with `useNeuroglancer().setState`. | `dist/index.js`: `n && a.state.restoreState(JSON.parse(n))`; `flyefish-web/src/pages/ViewerPage.tsx:118` uses `key=` |
| F14 | The package ships no `dist/index.d.ts` despite `types` pointing there. A local module shim is required. | tarball file list; `flyefish-web/src/vite-env.d.ts:5-15` |

---

## 1. Architecture decisions

### D1 — Embed via `@janelia/react-neuroglancer`, not an iframe

**Spec delta (§2, §4, §9).** The spec proposed vanilla TS + a vendored stock dist in
`public/ng/` + a same-origin iframe. Spec §13 authorizes preferring flyefish-web's
approach; the React component *is* how flyefish obtains and serves the dist.

Wins: Milestone 1 ("obtain a dist", the `blob:`-URL risk) is pre-verified by F1 and
reduces to a smoke test; no nested-document COEP problem; no `iframe.src` remount
dance; direct `Viewer` access so channels can be added as they finish ingesting.

Cost: React 19 + react-dom, which is noise next to an 8 MB Neuroglancer bundle.

Consequence of F2: `base` stays `/`, and `@janelia/react-neuroglancer/dist/assets/*`
must be copied to `/assets/` — exactly what `flyefish-web/vite.config.ts` does with
`vite-plugin-static-copy`. The app cannot be hosted under a sub-path.

### D2 — One packed file per pyramid level per channel

**Spec delta (§7).** The spec called for one OPFS file per zarr chunk. We keep the
spec's real point — **pre-chunk at ingest time, no strided gather in the SW hot path** —
but pack a level's chunks contiguously in chunk-grid order into a single file:

```
zarr/<datasetId>/.zgroup
zarr/<datasetId>/.zattrs
zarr/<datasetId>/<level>/.zarray
zarr/<datasetId>/<level>/index.json     { grid: [gz, gy, gx], chunkBytes }
zarr/<datasetId>/<level>/c<c>.bin       all chunks, z-major then y then x
```

Why: ~10k `getFileHandle({create:true})` + `createWritable()` + `close()` round-trips
per volume is the slowest part of ingest; one `createSyncAccessHandle()` per level per
channel replaces all of it with sequential appends. No OPFS file-count pressure. And
the SW ends up with *less* code, not more.

The offset math exists in exactly **one** place — the service worker:

```js
offset = ((z * gy + y) * gx + x) * chunkBytes
```

The ingest worker computes no offsets at all; it appends in `for z / for y / for x`
order, which is self-evidently the same ordering. `index.json` carries the grid so the
SW stays stateless.

Per-channel files (rather than one file spanning the `c` axis) mean a channel can be
ingested and served while later channels are still decoding — zarr treats a missing
chunk as `fill_value`, so un-ingested channels render as zeros instead of erroring.

### D3 — Decode on the main thread, chunk and downsample in a worker

Forced by F6. The split is also where the worker earns its keep:
`createSyncAccessHandle()` is worker-only and much faster than the async writable path.

- Main thread: `openH5J` (jsfive parses the whole container in memory), `createFFmpeg`,
  `readH5JChannelUint16`.
- `ingest.worker.ts`: receives the decoded buffer by **transfer** (zero-copy), crops
  padding, chunks level 0, builds the pyramid, writes OPFS, posts progress.

### D4 — Single image layer with a `c^` channel dimension

Per spec §9 and flyefish's proven `neuroglancer-base.json`: one zarr array shaped
`[nC, nZ, nY, nX]`, one image layer, `channelDimensions: { "c^": [1, ""] }`, and a
generated additive multi-channel shader. `invlerp` range comes from F11
(`[0,4095]` for 16-bit, `[0,255]` for 8-bit) — **not** `[0,65535]`.

### D5 — App + dev server only for now

No Dockerfile / nginx.conf / CI yet. `README.md` documents the required production
headers, and `flyefish-web/nginx.conf` is the template when deploy time comes.

---

## 2. Repo layout

```
.
├── index.html
├── package.json                 pnpm, type: module
├── pnpm-lock.yaml
├── tsconfig.json                strict, noUnusedLocals/Parameters, @/* -> src/*
├── tsconfig.node.json
├── vite.config.ts
├── vitest.config.ts             (or `test` block in vite.config.ts)
├── eslint.config.js             copied from flyefish-web
├── .prettierrc                  no semicolons, double quotes, tabWidth 2
├── .gitignore
├── README.md
├── public/
│   └── sw.js                    plain JS, dependency-free, served at /sw.js
└── src/
    ├── main.tsx                 SW registration -> render
    ├── App.tsx                  orchestration + phases
    ├── index.css
    ├── vite-env.d.ts            module shims for react-neuroglancer + web-h5j-loader
    ├── components/
    │   ├── SourcePicker.tsx     <input type=file> + URL field
    │   ├── ChannelList.tsx      checkboxes + bit-depth toggle
    │   └── IngestProgress.tsx   phase + per-channel percent
    ├── lib/
    │   ├── h5j.ts               ffmpeg instance, attrs -> resolved dimensions (F8/F10)
    │   ├── zarr.ts              .zgroup/.zattrs/.zarray builders, chunk grid, downsample
    │   ├── opfs.ts              nested path helpers, clear, quota estimate
    │   └── ngstate.ts           viewer state JSON + generated multi-channel shader
    ├── ingest.worker.ts         crop -> chunk -> pyramid -> OPFS
    └── lib/zarr.test.ts         vitest: grid math, offset round-trip, downsample, F8 resolution
```

Testing: **vitest** (zero config on top of Vite) over the pure functions in `zarr.ts`
and `h5j.ts`. The Milestone 2 synthetic gradient is the end-to-end check.

---

## 3. Build configuration

`vite.config.ts`:

```ts
plugins: [react(), viteStaticCopy({ targets: [
  // F2: hardcoded absolute /assets/ path in the ng bundle. Must be origin-root.
  { src: ngAssetsDir + "/*", dest: "assets" },
  // F7: vendor the ffmpeg core so COEP does not block a CDN fetch.
  { src: ffmpegCoreDir + "/*", dest: "ffmpeg-core" },
]})],
define: {
  global: "globalThis",                        // F12
  "process.env.NODE_ENV": '"production"',      // F7: module-scope read at import time
},
optimizeDeps: { include: ["@janelia/web-h5j-loader", "jsfive/dist", "@ffmpeg/ffmpeg"] },
server:  { port: 3000, headers: COOP_COEP },
preview: { headers: COOP_COEP },
```

`ngAssetsDir` resolved via `createRequire(...).resolve("@janelia/react-neuroglancer/package.json")`,
copying flyefish-web's approach so it works for both registry and `file:` installs.

`jsfive/dist` is CommonJS with `exports.File` assignments; the `optimizeDeps.include`
entry forces esbuild prebundling so `import * as hdf5 from 'jsfive/dist'` interops.

ffmpeg is instantiated by us, never via `createFFmpegForEnv`:

```ts
createFFmpeg({ corePath: "/ffmpeg-core/ffmpeg-core.js", log: false })
```

and passed as the `ffmpeg0` argument to `readH5JChannelUint16` — which sidesteps both
the CDN path and the library's own `process.env` read.

Dependencies: `react`, `react-dom`, `@janelia/react-neuroglancer`,
`@janelia/web-h5j-loader`, `@ffmpeg/ffmpeg@^0.10.1`, `@ffmpeg/core@0.10.0`.
No zarr library — the metadata is four small JSON documents.

---

## 4. Dimension resolution (replaces spec §6 "determine empirically")

F8/F9/F10 already answer this; the code still asserts rather than trusts, because a
wrong guess here is the confusing-but-not-crashing failure mode.

```
trueW, trueH   = attrs.channels.width[0], attrs.channels.height[0]
padW candidates, in order:
  1. trueW + (pad_right  ?? 0)
  2. ceil(trueW / 8) * 8        // F8
  3. trueW
padH likewise with pad_bottom
pick the first pair where (padW * padH) divides data.byteLength / bytesPerVoxel exactly
nZ = (data.byteLength / bytesPerVoxel) / (padW * padH)     // F8: frames can lie
```

Throw with a diagnostic if no candidate fits. Log the chosen `(padW, padH, nZ)` and
whether it disagreed with `frames`. Crop `[0,trueW) × [0,trueH)` during the chunk
gather — the row-run copy in spec §7 already does this for free by using `trueW` as the
run length and `padW` as the source row stride.

Voxel size: `attrs.voxel_size` in micrometers. If absent or zero → `[1,1,1]` **plus a
visible UI warning**. Do *not* fall back to `image_size / [w,h,d]` (F10).

---

## 5. Service worker (`public/sw.js`)

Zero module-scope state derived from ingestion. Scope `/`, so it covers the page and
every worker spawned from it.

```
install  -> skipWaiting()
activate -> clients.claim()
fetch    -> ignore unless same-origin AND pathname startsWith "/zarr/"
```

`serve(pathname, request)`:
1. `.zgroup` / `.zattrs` / `.zarray` / `index.json` → read the OPFS file whole,
   `Content-Type: application/json`.
2. `<level>/<c>.<z>.<y>.<x>` → read `<level>/index.json` (memoised in a plain `Map`;
   a pure derived cache, safe to lose on restart), compute
   `offset = ((z*gy + y)*gx + x) * chunkBytes`, return
   `file.slice(offset, offset + chunkBytes)`.
3. Anything missing → **404 immediately**, never hang (spec §8).

Headers on every synthesized response:
`Content-Length`, `Accept-Ranges: bytes`, `Cross-Origin-Resource-Policy: same-origin`,
`Cache-Control: no-store`.

`HEAD` returns headers with an empty body. `Range: bytes=a-b` returns `206` with a
correct `Content-Range: bytes a-b/total` — including the `bytes=0-0` size probe (F5),
where `total` must be the chunk length, not the packed file length, since each chunk is
an independent zarr key.

Registration, in `main.tsx` before rendering:

```ts
await navigator.serviceWorker.register("/sw.js", { scope: "/" })
await navigator.serviceWorker.ready
if (!navigator.serviceWorker.controller) location.reload()
```

---

## 6. OME-Zarr output

Target OME-Zarr 0.4 / zarr v2, uncompressed, `dimension_separator: "."`.
Chunk shape constant `CHUNK = [1, 64, 64, 64]` (512 KB at uint16).
`dtype`: `"<u2"` (16-bit, default) or `"|u1"` (8-bit).
Edge chunks are written **full-size, zero-padded** — zarr v2 requires it.

Pyramid: 2× box-downsample in x, y and z from the *previous* level until
`max(nX,nY,nZ) <= 128`, integer averaging in a `Uint32` accumulator. Not optional —
without it the zoomed-out and 3D views pull full-res chunks and the app feels broken.

`.zattrs` multiscales `axes` = `c`(channel), `z`/`y`/`x`(space, `micrometer`), with
`coordinateTransformations: [{ type: "scale", scale: [1, dz*2^L, dy*2^L, dx*2^L] }]`
per level.

Also emit an `omero` block with per-channel `label`, `color` and
`window: { min: 0, max: MAX, start: 0, end: MAX }` (MAX from F11). `flyefish-web/src/utils/zarrContrast.ts`
is the reference for how that metadata gets consumed if we want it later.

---

## 7. Viewer state

```ts
{
  layers: [{
    type: "image",
    name: datasetName,
    source: {
      url: `${location.origin}/zarr/${datasetId}/|zarr2:`,   // F4 — trailing slash matters
      transform: { outputDimensions: {
        "c^": [1, ""], z: [dz*1e-6, "m"], y: [dy*1e-6, "m"], x: [dx*1e-6, "m"] } },
    },
    channelDimensions: { "c^": [1, ""] },
    blend: "additive",
    shader: generatedMultiChannelShader(channels),   // invlerp range [0, MAX] per F11
  }],
  layout: "4panel",
}
```

Passed to `<NeuroglancerViewer initialState={JSON.stringify(state)} />` (F13 — string,
not object), mounted only once the first channel's level 0 is on disk, keyed by
`datasetId` so a new file remounts.

---

## 8. UI

`<input type="file" accept=".h5j">` + URL text field; channel checkbox list once
`attrs` are read; 16/8-bit toggle defaulting to 16; phase readout
(*Decoding H.265* → *Building pyramid* → *Writing chunks* → *Ready*) with per-channel
percent from the loader's `onProgress`; a **clear cached data** button that does
`root.removeEntry("zarr", { recursive: true })`; `navigator.storage.estimate()`
pre-check with a warning when the projected output exceeds the quota, and
`navigator.storage.persist()` to reduce eviction risk.

Memory guard per spec §6: project `padW*padH*nZ*bytesPerVoxel*1.33` (pyramid overhead),
warn above ~1.5 GB, process **one channel at a time** and drop references between
channels. Input file size is not a predictor — H5J is H.265-compressed.

---

## 9. Milestones and gates

Restructured because F1/F3/F6 pre-answer several of the spec's open questions.

| M | Work | Gate |
|---|------|------|
| **1** | Scaffold repo, copy ng assets to `/assets/`, render `NeuroglancerViewer` pointed at flyefish's public S3 zarr. | Viewer renders remote data. DevTools → Sources → Threads shows the chunk worker at a same-origin `/assets/chunk_worker.bundle-*.js` URL (re-confirms F1 at runtime). |
| **2** | SW + `opfs.ts` + `zarr.ts`. Ingest a synthetic 64³ gradient through the **real** pipeline into OPFS. | **Neuroglancer displays the synthetic volume.** The riskiest assumption in the design. Also confirms OPFS is reachable from a `ServiceWorkerGlobalScope`. Get here before touching H5J. |
| **3** | Wire `@janelia/web-h5j-loader` with COOP/COEP + vendored ffmpeg core. | No `SharedArrayBuffer` error, no `global is not defined` (F12), no unpkg fetch. Logged `(padW,padH,nZ)` reconciles with `byteLength` (F8). |
| **4** | Full level-0 ingest. Test with `../web-h5j-loader/testData/sphere64cone96cone128cylinder160_w256h128d64th3.h5j` (256×128×64, non-cubical). | Sphere at origin, **fat cone along +x**, **thin cone along +y**, cylinder along z. If x/y are swapped, fix the indexing — do not transpose the display. |
| **5** | Pyramid levels. | Zoomed-out and 3D views responsive; network panel shows low-res chunks at low zoom. |
| **6** | `R10E08-...-aligned_stack.h5j` (1210×566×174, real fluorescence). | Correct anatomy, correct physical scale in the coordinate readout, no OOM. |

---

## 9b. Verification status (updated after implementation)

No browser exists on the build machine, so **every gate that requires rendering is
still open**. What has and has not been established:

**Verified by execution**
- 88 unit/integration tests: conversion math, dimension reconciliation, viewer state,
  and the real `public/sw.js` driven end to end under Node against an in-memory OPFS
  populated by the real ingest path (chunk bytes, range semantics, 404-without-
  rejecting, routing guards).
- `pyramid()` level sizes match what `downsample2x` actually produces, including for
  1210x566x174. Packed chunks round-trip through the service worker's offset formula.
  Source padding never leaks into a chunk.
- `tsc`, `eslint`, `prettier`, and the production build.
- Build output: the chunk worker resolves to `/assets/chunk_worker.bundle-COc0o5e8.js`,
  which exists; `sw.js` at root; ffmpeg core at `/ffmpeg-core/`.
- Dev server sends COOP/COEP on every path checked, including `/assets/*`.
- The emitted dependency bundle contains `instanceof globalThis.File`, not `global`.
- Generated `.zattrs`/`.zarray` match the structure of a public OME-Zarr known to work
  with this Neuroglancer build.

**Not verified -- needs a Chromium session**
- M1: Neuroglancer renders at all.
- M2: the service worker actually intercepts the chunk worker's fetches. Use the
  "Load synthetic test volume" button; the long bar must run along +x and the short
  thin one along +y.
- OPFS reachable from a `ServiceWorkerGlobalScope` (flagged as a new risk in section 10).
- M3: no `SharedArrayBuffer` error; ffmpeg loads the vendored core.
- M4-M6: real H5J files, axis orientation, physical scale, and OOM behaviour.

**Bugs found and fixed during implementation**, none of which typechecking or the
build caught:
1. `jsfive/dist` cannot be an `optimizeDeps` entry -- it is transitive, so under pnpm
   it only resolves from inside the loader's directory.
2. The top-level `define` does not reach prebundled dependencies; `instanceof global`
   survived and would have thrown on any local file pick.
3. Neuroglancer's stylesheet was never imported; the viewer would have rendered
   unusable.
4. `resolveDims` admitted zero `pad_right`/`pad_bottom` as a real "no padding"
   candidate ahead of the alignment rule, and divisibility alone cannot separate the
   two -- a shearing failure on ordinary inputs.
5. The service worker's 404/405/500 paths carried no headers, contradicting the
   invariant the file documents.
6. The ingest worker kept the request's handle on the level-0 buffer alive across the
   whole pyramid loop (~230 MB per channel on the real dataset).
7. `App` resolved geometry per channel while all channels share one `.zarray`.

## 9c. Multi-channel chunking constraint (found in browser testing)

A single-channel volume rendered; a two-channel one did not -- no chunk requests, no
console error, nothing drawn. Metadata parsed fine and the service worker served
correctly (verified by hand and by the in-app prober).

The difference is `chunks[0]`. We emitted `shape: [nC, nZ, nY, nX]` with
`chunks: [1, 64, 64, 64]`, so with two channels the channel axis spanned two chunks.
Neuroglancer's own source carries the matching errors:

```
Channel dimension ... must map with stride 1 to a single data chunk dimensions
Channel dimension ... must have an offset of 0 in the chunk coordinate space
```

Note this is a constraint on rendering a dimension **as a channel dimension** -- the
thing that makes a multi-channel blend shader possible. A chunked channel axis is
perfectly readable as an ordinary scrubbable dimension, which is why multi-channel
OME-Zarr generally works in Neuroglancer. It is declaring `c^` in `channelDimensions`
and indexing it from the shader with `channel=[i]` that requires the whole axis in one
chunk. The reference dataset that works with this build has `chunks[0] === shape[0]`.

**Change:** `chunks` is now `[nC, 64, 64, 64]`. A chunk therefore spans every channel,
and within it the C-order layout `[c][z][y][x]` gives each channel a contiguous
sub-block at `c * subChunkBytes`. Ingest still decodes one channel at a time and writes
its sub-blocks at a stride through a single `chunks.bin` per level, so the memory rule
is unaffected; sub-blocks for channels not yet ingested read back as zeros, which zarr
treats as `fill_value`. The packed file reserves the level's full extent up front,
because only the last channel writes the final chunk's tail.

**Cost:** chunk size scales with channel count -- 1 MB for two 16-bit channels, 2 MB for
four. Fine at these counts; if a many-channel file ever shows up, shrink the spatial
chunk to compensate.

**Plan B if this proves wrong:** one image layer per channel, each selecting its channel
via `localPosition: [i]` with `c` left as an ordinary dimension and `chunks[0]` back at
1. `flyefish-web/src/utils/zarrContrast.ts` documents that pattern, so it is known to
work.

## 10. Risks

Carried forward from spec §12, minus the ones now closed, plus new ones.

| Risk | Status / detection | Mitigation |
|---|---|---|
| Chunk worker from `blob:` URL | **Closed by F1**; re-checked at M1 | — |
| `SharedArrayBuffer` unavailable | M3 | COOP/COEP on dev + preview; no iframe to worry about under D1 |
| Loader fails in a Web Worker | **Closed by F6** — it does | D3: decode on main thread by design |
| Single-`ArrayBuffer` size limit | M6 | One channel at a time; 8-bit path; pre-decode projection warning |
| OPFS quota exhaustion | M6 | `storage.estimate()` pre-check + clear button |
| Padding not stripped | **Closed by F8**; cones look wrong at M4 | Candidate-based resolution in §4, asserted against `byteLength` |
| SW terminated mid-session | Intermittent 404s | No module-scope state beyond the derived `index.json` cache |
| **New:** OPFS unsupported in `ServiceWorkerGlobalScope` | M2 gate | Would force a `postMessage`-to-client fallback; kills the stateless-SW property. Check early. |
| **New:** `jsfive/dist` CJS interop under Vite | M3, import-time failure | `optimizeDeps.include`; fall back to `import hdf5 from "jsfive"` (the `module` entry) |
| **New:** app hosted under a sub-path | Chunk worker 404s | F2: `base: "/"` only. Document in README. |
| **New:** `invlerp` range left at `[0,65535]` | Volume renders nearly black | F11: `[0,4095]` for 16-bit, `[0,255]` for 8-bit |
