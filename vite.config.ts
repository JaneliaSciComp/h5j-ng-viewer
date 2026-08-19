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
  "dist/assets"
)

// ffmpeg.wasm 0.10 defaults its `corePath` to unpkg.com, which cross-origin
// isolation blocks. Vendor the core locally and pass an explicit corePath
// (see src/lib/h5j.ts).
const ffmpegCoreDir = path.join(packageDir("@ffmpeg/core"), "dist")

// Cross-origin isolation is required for SharedArrayBuffer, which ffmpeg.wasm needs
// for its threads. Must be present on *every* response.
// @janelia/web-h5j-loader tests `src instanceof global.File` and @ffmpeg/ffmpeg reads
// `process.env.NODE_ENV` at module scope. Both are webpack-isms that Vite does not
// shim. The top-level `define` below does NOT reach prebundled dependencies -- the
// dep optimizer is a separate esbuild pass -- so the same substitutions have to be
// declared twice. Without the esbuild copy, passing a File throws
// "global is not defined" at runtime while everything typechecks and builds fine.
const shims = {
  global: "globalThis",
  "process.env.NODE_ENV": '"production"',
}

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
  server: { port: 3000, headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
