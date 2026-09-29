import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { createRequire } from "node:module"
import { viteStaticCopy } from "vite-plugin-static-copy"
import basicSsl from "@vitejs/plugin-basic-ssl"

const require = createRequire(import.meta.url)

const packageDir = (id: string) =>
  path.dirname(require.resolve(`${id}/package.json`))

// Neuroglancer's chunk worker is constructed from the absolute, build-time-baked
// path `/assets/chunk_worker.bundle-<hash>.js`, so the component's bundled assets
// must land at the origin root under `/assets/`. This also means the app cannot be
// hosted under a sub-path -- `base` must stay "/".
const ngAssetsDir = path.join(
  packageDir("@janelia/react-neuroglancer"),
  "dist/assets"
)

// ffmpeg.wasm 0.10 defaults its `corePath` to unpkg.com, which cross-origin
// isolation blocks. Vendor the core locally and pass an explicit corePath
// (see src/lib/h5j.ts).
const ffmpegCoreDir = path.join(packageDir("@ffmpeg/core"), "dist")

// Cross-origin isolation is required for SharedArrayBuffer, which ffmpeg.wasm needs
// for its threads. Must be present on *every* response.
// @janelia/web-h5j-loader tests `src instanceof global.File`, and `global` is a
// webpack-ism Vite does not shim. This has to be declared twice: the top-level
// `define` does NOT reach prebundled dependencies, because the dep optimizer is a
// separate esbuild pass. Without the esbuild copy, passing a File throws
// "global is not defined" at runtime while everything typechecks and builds fine.
//
// Do NOT add `process.env.NODE_ENV` here. @ffmpeg/ffmpeg does read it at module
// scope, but Vite's own optimizer already substitutes it, and pinning it to
// "production" collapses React's `jsx-dev-runtime` to its production stub -- which
// sets `exports.jsxDEV = void 0` on purpose. Vite's dev JSX transform still emits
// jsxDEV calls, so the app dies with "jsxDEV is not a function" and a black screen.
const shims = {
  global: "globalThis",
}

const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
}

// Service workers, OPFS and SharedArrayBuffer are all gated behind a secure context.
// http://localhost qualifies; http://<ip> does not. So reaching the dev server from
// another machine needs HTTPS -- `npm run dev:https` sets this and accepts the
// self-signed-certificate warning once per browser.
const useHttps = process.env.HTTPS === "1"

export default defineConfig({
  base: "/",
  plugins: [
    react(),
    ...(useHttps ? [basicSsl()] : []),
    viteStaticCopy({
      targets: [
        { src: `${ngAssetsDir}/*`, dest: "assets" },
        { src: `${ffmpegCoreDir}/*`, dest: "ffmpeg-core" },
      ],
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  define: shims,
  optimizeDeps: {
    // Both are CommonJS; prebundling is what makes their named-export interop work.
    // `jsfive` is deliberately absent: the loader imports it as `jsfive/dist`, which
    // only resolves from inside the loader's own directory under pnpm's strict
    // node_modules, so esbuild must pull it in transitively rather than as an entry.
    include: ["@janelia/web-h5j-loader", "@ffmpeg/ffmpeg"],
    esbuildOptions: { define: shims },
  },
  worker: { format: "es" },
  // `strictPort` matters more here than in a typical app: the service worker
  // registration, its OPFS contents and any cached Neuroglancer state are all keyed to
  // the origin. Silently drifting to :3001 when :3000 is taken would leave a stale
  // registration serving one port while the page runs on another.
  // The `host: true` is necessary for publishing ports when running in a dev container.
  server: { port: 3000, strictPort: true, host: true, headers: crossOriginIsolation },
  preview: { port: 3000, strictPort: true, host: true, headers: crossOriginIsolation },  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
