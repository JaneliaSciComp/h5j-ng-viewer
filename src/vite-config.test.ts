// A source-level guard on vite.config.ts, not a behavioural test. It exists because
// the regressions it catches are silent: nothing fails, the build succeeds, and the
// app shows a black screen or throws only on a code path no unit test reaches.
//
// The config is read as text rather than imported because importing it from inside
// `src` crosses into the composite tsconfig.node.json project, which tsc then wants
// prebuilt.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync("vite.config.ts", "utf8")

describe("vite.config.ts", () => {
  it("does not pin process.env.NODE_ENV", () => {
    // Pinning it to "production" collapses React's jsx-dev-runtime to its production
    // stub, which sets `exports.jsxDEV = void 0` on purpose, while Vite's dev
    // transform still emits jsxDEV calls: "jsxDEV is not a function", black screen,
    // every test still green. Vite's own dep optimizer already substitutes it, so
    // there is nothing to gain. A define entry is always written with quotes; the
    // prose warning in the config uses backticks, so it does not match here.
    expect(source).not.toContain('"process.env.NODE_ENV"')
  })

  it("shims `global` in both define maps", () => {
    // @janelia/web-h5j-loader tests `src instanceof global.File`, which Vite does not
    // shim. The top-level define does not reach prebundled dependencies -- the dep
    // optimizer is a separate esbuild pass -- so it has to appear twice. Missing the
    // esbuild copy throws "global is not defined" on every local file pick.
    expect(source).toContain('global: "globalThis"')
    expect(source).toContain("esbuildOptions: { define: shims }")
  })

  it("keeps base at the origin root", () => {
    // Neuroglancer's chunk worker is constructed from the absolute path
    // /assets/chunk_worker.bundle-<hash>.js. Under any other base it 404s and the
    // viewer silently loads nothing.
    expect(source).toContain('base: "/"')
  })

  it("sets cross-origin isolation on both dev and preview", () => {
    // ffmpeg.wasm needs SharedArrayBuffer, which needs these headers on every
    // response. Without them the decoder fails with "SharedArrayBuffer is not
    // defined".
    expect(source).toContain('"Cross-Origin-Opener-Policy": "same-origin"')
    expect(source).toContain('"Cross-Origin-Embedder-Policy": "require-corp"')
    expect(source).toContain(
      "server: { port: 3000, headers: crossOriginIsolation }"
    )
    expect(source).toContain("preview: { headers: crossOriginIsolation }")
  })
})
