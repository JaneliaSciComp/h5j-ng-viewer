// Opens a real H5J container end to end -- fetch, jsfive, attribute normalization --
// against the fixture in testData/, whose ground truth is the .yml beside it.
//
// Everything else about H5J is tested against hand-written attribute objects, which
// cannot catch the thing that actually varies: jsfive hands back the same logical
// attribute as a number, an array or a typed array depending on how HDF5 stored it. This
// is the only test that sees what the library really returns.
//
// It stops at the container. Decoding a channel needs ffmpeg.wasm, which injects a
// <script> tag and spawns worker threads, so it cannot run here -- Node has neither
// `document` nor `Worker`.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { readFileSync } from "node:fs"
import { openSource } from "@/lib/h5j"
import type { H5JInfo } from "@/types"

const FIXTURE = "testData/sphere64cone96cone128cylinder160_w256h128d64th3.h5j"

let server: Server
let info: H5JInfo

beforeAll(async () => {
  // The loader reaches for `global.File` to tell a File from a URL; vite.config.ts
  // defines `global` as `globalThis` for the app, and the test needs the same.
  ;(globalThis as unknown as { global: unknown }).global = globalThis

  // Served over HTTP because that is the path the app uses, and because Node has no
  // FileReader, so the File branch of openH5J is unreachable here.
  const bytes = readFileSync(FIXTURE)
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" })
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  const { port } = server.address() as { port: number }
  info = (await openSource(`http://127.0.0.1:${port}/${FIXTURE}`)).info
})

afterAll(() => {
  server?.close()
})

describe("a real H5J container", () => {
  it("reports its one channel and that channel's content type", () => {
    expect(info.channels).toEqual([
      { name: "Channel_0", contentType: "reference" },
    ])
  })

  it("takes the nominal size from the Channels group, not image_size", () => {
    // Both agree in this file, which is exactly why the assertion has to be about
    // provenance rather than value: `image_size` holds voxel counts despite its name,
    // so trusting it as a physical extent is a mistake that stays invisible here.
    expect(info.nominalSize).toEqual({ x: 256, y: 128, z: 64 })
  })

  it("normalizes attributes that HDF5 stored as arrays", () => {
    // The .yml records `frames: [64]`, `height: [128]`, `width: [256]` -- jsfive
    // returns them as single-element arrays, and nominalSize above proves they were
    // unwrapped. The raw attrs are kept so a diagnostic can still show the original.
    const channels = info.attrs.channels as Record<string, unknown>
    expect(channels.width).toEqual([256])
    expect(channels.frames).toEqual([64])
  })

  it("reads the voxel size and channel spec", () => {
    expect(info.voxelSize).toEqual({ x: 0.44, y: 0.44, z: 0.44 })
    expect(info.channelSpec).toBe("r")
  })

  it("records a declared padding of zero as zero, not as absent", () => {
    // This is the case resolveDims cannot take at face value: 0 is indistinguishable
    // from "not recorded", so the macroblock alignment rule has to win. Here 256 and
    // 128 are already multiples of 8, so both readings agree -- the point is that the
    // parse does not invent padding that the file does not declare.
    const channels = info.attrs.channels as Record<string, unknown>
    expect(channels.pad_right).toEqual([0])
    expect(channels.pad_bottom).toEqual([0])
  })
})
