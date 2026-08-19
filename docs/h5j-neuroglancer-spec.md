# Build Spec: Client-Side H5J → OME-Zarr → Neuroglancer Viewer

## 0. Objective

Build a browser-only web app that:

1. Loads an **H5J** file (HDF5 container, H.265-compressed volumetric microscopy data) entirely in the browser using `@janelia/web-h5j-loader`.
2. Converts the decoded voxel data into a valid **OME-Zarr (v0.4 / zarr v2)** hierarchy, stored in **OPFS** (Origin Private File System).
3. Serves that hierarchy over HTTP via a **service worker** acting as a virtual origin.
4. Embeds a **stock, unmodified Neuroglancer** build in the page and points it at the service-worker URL.

**Hard constraint: Neuroglancer source code must not be modified.** We deploy the prebuilt distribution as-is and communicate with it only through standard HTTP requests and its public URL-fragment state API.

There is no backend. No data leaves the browser.

---

## 1. Why this architecture

Neuroglancer reads all file-based formats through key-value store drivers, and the only *root* kvstores upstream are `http://`, `gs://`, and `s3://`. There is no in-memory or local-file root store. So to feed it client-side data without patching it, we must produce something that looks like an HTTP server.

A service worker is exactly that: it intercepts `fetch()` for its scope and synthesizes `Response` objects. Two properties make this work:

- Neuroglancer performs chunk fetches from a **dedicated web worker** (`chunk_worker.bundle.js`), not the main thread. Dedicated workers spawned from a controlled page are themselves service-worker clients, so their fetches *are* intercepted.
- Service workers are **same-origin only**. This is why we self-host Neuroglancer instead of using `neuroglancer-demo.appspot.com`.

### Key design decision: pre-chunk at ingest time

Do **not** store a flat volume in OPFS and have the service worker slice chunks on demand. Gathering a strided 3D chunk from a flat file requires thousands of small reads per chunk and makes the SW hot path slow and complex.

Instead, during ingestion, write **one OPFS file per zarr chunk**, keyed by its exact zarr path. The service worker then becomes a trivial path→file lookup with no arithmetic. The strided gather happens once, in memory, where it is fast.

This also makes the app robust against service-worker lifecycle termination — the SW holds no state at all and can be killed and restarted freely.

---

## 2. Tech stack

- **Vite** + **TypeScript**, vanilla (no React required; Neuroglancer is not a React component).
- `@janelia/web-h5j-loader` for H5J decoding.
- Stock Neuroglancer distribution served from `/ng/`.
- No other runtime dependencies. Do not add a zarr-writing library — the zarr v2 metadata is a handful of JSON files and writing it directly is less code than wiring up a dependency.

---

## 3. Cross-origin isolation — read this before writing any code

`@janelia/web-h5j-loader` uses `ffmpeg.wasm`, which uses threads, which require `SharedArrayBuffer`, which requires **cross-origin isolation**. Without it you get `SharedArrayBuffer is not defined`.

Every response from the dev server and the production server must carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Consequences that will bite you if ignored:

- **The Neuroglancer iframe must also be served with these headers.** Under `COEP: require-corp`, a nested document that does not itself assert COEP is blocked from loading. Set the headers globally for all paths, including `/ng/*`.
- **Service-worker-synthesized responses** should include `Cross-Origin-Resource-Policy: same-origin`. Same-origin subresources are technically fine without it, but setting it explicitly avoids a class of confusing failures.
- If `ffmpeg.wasm` loads its core from a CDN, it will be blocked. Vendor the core files locally and configure the loader to use local paths.

Vite config:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: { headers: { /* same */ } },
});
```

For production, configure the same headers on whatever static host is used. Document this in the README.

---

## 4. Directory layout

```
/
├── index.html              # our app shell: file picker, progress, iframe
├── src/
│   ├── main.ts             # UI + orchestration
│   ├── ingest.worker.ts    # H5J decode → chunk → OPFS
│   ├── zarr.ts             # OME-Zarr metadata generation + chunk math
│   ├── opfs.ts             # OPFS read/write helpers
│   └── ngstate.ts          # builds Neuroglancer #! state JSON
├── sw.js                   # service worker (plain JS, not bundled by Vite)
├── public/
│   └── ng/                 # stock Neuroglancer dist — DO NOT EDIT
│       ├── index.html
│       ├── main.bundle.js
│       ├── chunk_worker.bundle.js
│       └── ...
└── vite.config.ts
```

### Obtaining the Neuroglancer dist

Try in this order and document which one worked:

1. `npm pack neuroglancer` and copy the prebuilt `dist/` output if present.
2. Extract the bundled static client from the `neuroglancer` PyPI package (`pip download neuroglancer`, then look under `neuroglancer/static/`).
3. `git clone https://github.com/google/neuroglancer && npm ci && npm run build` — with **zero source edits**.

**Verification gate:** after copying, load `http://localhost:5173/ng/` directly. It must render the empty Neuroglancer UI. Then open DevTools → Sources → Threads and confirm a chunk worker thread exists and its script URL is a normal same-origin `.js` URL, **not** a `blob:` URL. If it is a `blob:` URL, the service worker will not intercept its fetches and the whole approach fails — in that case switch to a different dist source from the list above.

---

## 5. Service worker registration

Stock Neuroglancer's `index.html` does not register a service worker, and we may not edit it. Registration is per-origin and persists across navigations, so we register from **our** page instead.

In `main.ts`, before anything else:

```ts
const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
await navigator.serviceWorker.ready;
if (!navigator.serviceWorker.controller) {
  location.reload();   // first visit loads uncontrolled
}
```

In `sw.js`, use `self.skipWaiting()` in `install` and `self.clients.claim()` in `activate`.

Because the scope is `/`, it covers `/ng/` — so the Neuroglancer iframe document *and* its chunk worker both load as controlled clients.

Vite note: `sw.js` must be served from the root with correct MIME type and must not be transformed into an ES module with bare imports. Put it in `public/` or use a dedicated build entry. Keep it dependency-free plain JavaScript.

If you later move `sw.js` into a subdirectory, the server must send `Service-Worker-Allowed: /` on it.

---

## 6. H5J loading

API (from the library README):

```ts
import { openH5J, getH5JAttrs, readH5JChannelUint8, readH5JChannelUint16 }
  from '@janelia/web-h5j-loader';

const fileH5J = await openH5J(fileOrUrl);   // accepts a File or a URL string
const attrs   = getH5JAttrs(fileH5J);
const data    = await readH5JChannelUint16(attrs.channels.names[0], fileH5J);
```

`attrs` exposes (mirroring the H5J metadata YAML structure):

- `attrs.channels.names` — array of channel names
- `image_size` — physical extent, 3 floats
- `voxel_size` — physical voxel size, 3 floats
- Channels group attrs: `width`, `height`, `frames`, `pad_right`, `pad_bottom`

### Things to determine empirically, not assume

Write a small probe step that runs first and logs its findings:

1. **Dimension order of the returned typed array.** Almost certainly `[z][y][x]` with x fastest (it comes from video frames), but verify.
2. **Whether padding is stripped.** H.265 requires macroblock-aligned frames, hence `pad_right` / `pad_bottom`. Check whether `data.length === width * height * frames` or whether it equals the padded dimensions. If padded, crop during chunking.
3. **Whether the loader runs inside a Web Worker.** `ffmpeg.wasm` and `jsfive` may assume a window context. Attempt to run ingestion in `ingest.worker.ts`; if the loader throws, fall back to decoding on the main thread and doing only the chunking/downsampling in the worker. Note which path was taken.

### Choosing bit depth

Use `readH5JChannelUint16` (preserves the original 12-bit values) unless memory forces otherwise. `readH5JChannelUint8` halves memory at some accuracy cost. Make it a UI toggle defaulting to 16-bit.

### Memory ceiling — important

The loader materializes an **entire channel** as one typed array. For `W×H×D` uint16 that is `W*H*D*2` bytes in a single `ArrayBuffer`. Chrome caps a single `ArrayBuffer` well below the tab's total budget; multi-gigabyte allocations will fail.

Mitigations, in order:
- Process **one channel at a time**. Write its chunks to OPFS, then drop all references and let GC reclaim before starting the next channel.
- Offer the 8-bit path for large volumes.
- Before decoding, compute the projected size from `attrs` and warn the user if it exceeds ~1.5 GB.

Note that the input file size is *not* a useful predictor here — H5J is H.265-compressed, so a 1 GB file can decode to many times that.

---

## 7. OME-Zarr output format

Target **OME-Zarr 0.4**, backed by **zarr v2**, uncompressed. Neuroglancer reads this reliably and it is the least ambiguous option.

### Layout in OPFS

Mirror the URL path exactly, so the service worker does no translation:

```
zarr/<datasetId>/.zgroup
zarr/<datasetId>/.zattrs
zarr/<datasetId>/0/.zarray
zarr/<datasetId>/0/<c>.<z>.<y>.<x>      ← one file per chunk
zarr/<datasetId>/1/.zarray
zarr/<datasetId>/1/<c>.<z>.<y>.<x>
...
```

OPFS has no real directories in the POSIX sense but does have nested `FileSystemDirectoryHandle`s. Either nest them or flatten by replacing `/` with a separator in the filename. Flattening is simpler and faster; if you flatten, use a character that cannot appear in a zarr key (e.g. `\u0000` or `__`) and keep the mapping in one function in `opfs.ts`.

### `.zgroup`

```json
{ "zarr_format": 2 }
```

### `.zattrs` (root)

```json
{
  "multiscales": [{
    "version": "0.4",
    "name": "<datasetId>",
    "axes": [
      { "name": "c", "type": "channel" },
      { "name": "z", "type": "space", "unit": "micrometer" },
      { "name": "y", "type": "space", "unit": "micrometer" },
      { "name": "x", "type": "space", "unit": "micrometer" }
    ],
    "datasets": [
      { "path": "0", "coordinateTransformations": [
          { "type": "scale", "scale": [1, dz, dy, dx] } ] },
      { "path": "1", "coordinateTransformations": [
          { "type": "scale", "scale": [1, 2*dz, 2*dy, 2*dx] } ] }
    ]
  }]
}
```

`dx`, `dy`, `dz` come from `attrs.voxel_size` (in micrometers). If `voxel_size` is absent or zero, fall back to `image_size / [width, height, frames]`, and if that is also unavailable, use `[1,1,1]` and surface a warning in the UI — wrong scale produces a viewer that "works" but shows a squashed volume, which is a confusing failure mode.

### `.zarray` (per level)

```json
{
  "zarr_format": 2,
  "shape": [nC, nZ, nY, nX],
  "chunks": [1, 64, 64, 64],
  "dtype": "<u2",
  "compressor": null,
  "fill_value": 0,
  "order": "C",
  "filters": null,
  "dimension_separator": "."
}
```

Use `"|u1"` for the 8-bit path. `dimension_separator: "."` matches the chunk filenames above.

### Chunking

Chunk shape `[1, 64, 64, 64]` is a good default: 512 KB per chunk at uint16, well inside Neuroglancer's comfortable range, and gives decent performance in all three orthogonal views. Make it a constant, not a magic number.

Edge chunks: zarr v2 requires stored chunks to be **full-size**, zero-padded at the volume boundary. Do not write truncated files.

Gather loop for one chunk — copy row-runs along x, which are contiguous in the source:

```
for cz in chunk z-range:
  for cy in chunk y-range:
    srcOffset = ((cz * nY) + cy) * nX + chunkX0
    dstOffset = ((cz - z0) * CY + (cy - y0)) * CX
    chunkArray.set(src.subarray(srcOffset, srcOffset + runLength), dstOffset)
```

### Multiscale pyramid

Generate levels by 2× box-downsampling in x, y, and z until `max(nX, nY, nZ) <= 128`.

This is not optional. A single-scale dataset loads, but Neuroglancer will pull full-resolution chunks for the zoomed-out and 3D views and the app will feel broken. The pyramid costs ~33% extra storage and a few seconds of compute.

Downsample from the previous level, not from level 0, so cost decays geometrically. Use integer averaging in a wider accumulator to avoid overflow.

---

## 8. Service worker implementation

`sw.js` is deliberately dumb. Scope: only handle requests whose path starts with `/zarr/`. Everything else falls through to the network.

```js
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/zarr/')) return;
  event.respondWith(serve(url.pathname));
});
```

`serve(path)`:

1. Map the path to an OPFS file handle.
2. If missing → return `404` **immediately**. Do not hang. Neuroglancer probes speculatively and a stalled request stalls the whole load.
3. If present → return `200` with the file's bytes.

Response headers:

```
Content-Type: application/json          (for .zarray/.zattrs/.zgroup)
Content-Type: application/octet-stream  (for chunks)
Content-Length: <n>
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store
Accept-Ranges: bytes
```

**Range request support is required.** Neuroglancer's kvstore layer issues byte-range reads. Parse `Range: bytes=start-end` and reply `206 Partial Content` with a correct `Content-Range: bytes start-end/total`. A missing or malformed `Content-Range` causes failures that are hard to diagnose because Neuroglancer surfaces them as generic fetch errors.

Also handle `HEAD` (return headers, empty body).

Read from OPFS in the SW via:

```js
const root = await navigator.storage.getDirectory();
const handle = await root.getFileHandle(name);
const file = await handle.getFile();
const buf = await file.slice(start, end).arrayBuffer();
```

`file.slice()` before `arrayBuffer()` avoids materializing whole files for range reads.

The service worker must hold **no module-scope state** derived from ingestion. It may be terminated and restarted between any two requests. All state lives in OPFS.

---

## 9. Embedding Neuroglancer

Use a **same-origin iframe** pointing at the stock dist, with state passed in the URL fragment:

```ts
const state = {
  layers: [{
    type: 'image',
    name: channelName,
    source: `zarr://${location.origin}/zarr/${datasetId}/`,
  }],
  layout: '4panel',
};
iframe.src = `/ng/#!${encodeURIComponent(JSON.stringify(state))}`;
```

Notes:

- Specify the `zarr://` scheme explicitly rather than relying on auto-detection. This skips a round of speculative probing for candidate metadata files.
- The trailing slash on the source URL matters.
- For multi-channel data, either emit one image layer per channel with a `c` selection, or a single layer and let the user scrub the `c` dimension in the UI. Start with the single-layer version; it is less code and Neuroglancer handles the channel dimension natively.
- To change datasets, reassign `iframe.src`. Do not try to drive the viewer through `postMessage` — stock Neuroglancer does not expose a message API.

---

## 10. UI

Minimal is fine. Required elements:

- `<input type="file" accept=".h5j">` and a URL text field (the loader accepts both `File` and URL string).
- Channel list with checkboxes once `attrs` are read.
- Bit-depth toggle (16-bit default).
- Progress display with distinct phases: *Decoding H.265* → *Building pyramid* → *Writing chunks* → *Ready*. Report per-channel progress; decode is the long pole and users need to see it moving.
- A "clear cached data" button that wipes the OPFS `zarr/` tree. Volumes are large and users will otherwise silently fill their disk quota.
- Call `navigator.storage.estimate()` before ingesting and warn if the projected output exceeds the available quota. Consider `navigator.storage.persist()` to reduce eviction risk.

---

## 11. Build order and verification gates

Do not proceed past a gate until it passes.

**Milestone 1 — Neuroglancer serves.**
Copy the dist to `public/ng/`. Load `/ng/` directly. Gate: UI renders, and the chunk worker's script URL is not a `blob:` URL.

**Milestone 2 — Service worker intercepts.**
Register the SW. Have it return a hardcoded fake OME-Zarr describing a small synthetic volume (e.g. a 64³ gradient generated in the SW). Point the iframe at it. Gate: **Neuroglancer displays the synthetic volume.** This proves interception works from the chunk worker, which is the single riskiest assumption in the design. Get here before touching H5J at all.

**Milestone 3 — H5J decodes.**
Wire up the loader with COOP/COEP headers set. Log `attrs`, `data.length`, and the padding check. Gate: no `SharedArrayBuffer` error, and dimensions reconcile with `attrs`.

**Milestone 4 — Ingest pipeline.**
Chunk level 0 into OPFS, generate metadata, serve from the SW. Gate: use `testData/sphere64cone96cone128cylinder160_w256h128d64th3.h5j` from the loader repo — a non-cubical 256×128×64 volume containing a **sphere at the origin** (value 64 in 8-bit), a **fat cone along +x** (96), a **thin cone along +y** (128), and a **cylinder along z** (160).

This dataset is the acceptance test for axis order and orientation. Verify in Neuroglancer that the fat cone points along +x and the thin cone along +y. If they are swapped, the `[z][y][x]` assumption is wrong — fix the indexing rather than transposing the display.

**Milestone 5 — Pyramid.**
Add downsampled levels. Gate: zoomed-out and 3D views are responsive; network panel shows low-res chunks being fetched at low zoom.

**Milestone 6 — Real data.**
Test with `R10E08-...-aligned_stack.h5j` (1210×566×174, real fluorescence data). Gate: correct anatomy, correct physical scale in the coordinate readout, no OOM.

---

## 12. Known risks

| Risk | Detection | Mitigation |
|---|---|---|
| Chunk worker loaded from `blob:` URL | Milestone 1 gate | Use a different Neuroglancer dist source |
| `SharedArrayBuffer` unavailable | Milestone 3 | Verify COOP/COEP on **every** response incl. `/ng/*` |
| Loader fails inside a Web Worker | Milestone 3 | Decode on main thread, chunk in worker |
| Single-`ArrayBuffer` size limit | Milestone 6 | One channel at a time; offer 8-bit path |
| OPFS quota exhaustion | Milestone 6 | `storage.estimate()` pre-check + clear button |
| Padding not stripped by loader | Milestone 4 (cones look wrong) | Crop using `pad_right` / `pad_bottom` |
| SW terminated mid-session | Intermittent 404s | Ensure SW has zero module-scope state |

---

## 13. Reference links

- H5J loader: https://github.com/JaneliaSciComp/web-h5j-loader (npm: `@janelia/web-h5j-loader`)
- H5J format spec: https://github.com/JaneliaSciComp/workstation/blob/master/docs/H5JFileFormat.md
- Neuroglancer: https://github.com/google/neuroglancer
- Neuroglancer data source docs: https://neuroglancer-docs.web.app/datasource/index.html
- Neuroglancer zarr driver: https://neuroglancer-docs.web.app/datasource/zarr/index.html
- OME-NGFF 0.4 spec: https://ngff.openmicroscopy.org/0.4/

**Note:** `https://github.com/JaneliaSciComp/flyefish-web` was referenced as an embedding example but returns 404 (private or renamed). If you have access, read it and prefer its embedding approach over §9 where they differ — particularly regarding how it obtains and serves the Neuroglancer dist. Otherwise §9 is self-contained.
