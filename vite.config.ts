import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { createRequire } from "node:module"
import { viteStaticCopy } from "vite-plugin-static-copy"

const require = createRequire(import.meta.url)

const packageDir = (id: string) =>
  path.dirname(require.resolve(`${id}/package.json`))

// Neuroglancer's chunk worker is constructed from the absolute, build-time-baked
// path `/assets/chunk_worker.bundle-<hash>.js`, so the component's bundled assets
// must land at the origin root under `/assets/`. This also means the app cannot be
// hosted under a sub-path -- `base` must stay "/".
const ngAssetsDir = path.join(
  packageDir("@janelia/react-neuroglancer"),
  "dist/assets",
)

// ffmpeg.wasm 0.10 defaults its `corePath` to unpkg.com, which cross-origin
// isolation blocks. Vendor the core locally and pass an explicit corePath
// (see src/lib/h5j.ts).
const ffmpegCoreDir = path.join(packageDir("@ffmpeg/core"), "dist")

// Cross-origin isolation is required for SharedArrayBuffer, which ffmpeg.wasm needs
// for its threads. Must be present on *every* response.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
}

export default defineConfig({
  base: "/",
  plugins: [
    react(),
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
  define: {
    // @janelia/web-h5j-loader tests `src instanceof global.File`; `global` is a
    // webpack-ism that Vite does not shim.
    global: "globalThis",
    // @ffmpeg/ffmpeg reads process.env.NODE_ENV at module scope, which would throw
    // a ReferenceError in the browser.
    "process.env.NODE_ENV": '"production"',
  },
  optimizeDeps: {
    // These are CommonJS; force prebundling so the named-export interop works.
    include: ["@janelia/web-h5j-loader", "jsfive/dist", "@ffmpeg/ffmpeg"],
  },
  worker: { format: "es" },
  server: { port: 3000, headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
