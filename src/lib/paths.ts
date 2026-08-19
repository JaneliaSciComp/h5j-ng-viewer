// OPFS layout, mirroring the URL paths the service worker serves so that no
// translation is needed beyond stripping the leading slash:
//
//   zarr/<datasetId>/.zgroup
//   zarr/<datasetId>/.zattrs
//   zarr/<datasetId>/<level>/.zarray
//   zarr/<datasetId>/<level>/index.json    -> LevelIndex
//   zarr/<datasetId>/<level>/c<c>.bin      -> every chunk of channel <c>, packed
//
// A level's chunks are packed contiguously in chunk-grid order (z outer, then y,
// then x), so a chunk's offset is a single multiply. The service worker
// (public/sw.js) re-derives that offset and the `c<c>.bin` name; it cannot import
// from here because it is a dependency-free plain script.

export const ZARR_ROOT = "zarr"

/** URL prefix the service worker intercepts. Keep in sync with public/sw.js. */
export const ZARR_URL_PREFIX = `/${ZARR_ROOT}/`

export const datasetPath = (datasetId: string) => `${ZARR_ROOT}/${datasetId}`

export const levelPath = (datasetId: string, level: number) =>
  `${datasetPath(datasetId)}/${level}`

export const zgroupPath = (datasetId: string) =>
  `${datasetPath(datasetId)}/.zgroup`

export const zattrsPath = (datasetId: string) =>
  `${datasetPath(datasetId)}/.zattrs`

export const zarrayPath = (datasetId: string, level: number) =>
  `${levelPath(datasetId, level)}/.zarray`

export const levelIndexPath = (datasetId: string, level: number) =>
  `${levelPath(datasetId, level)}/index.json`

/** Packed chunk file for one channel of one level. */
export const chunkFilePath = (
  datasetId: string,
  level: number,
  channelIndex: number
) => `${levelPath(datasetId, level)}/c${channelIndex}.bin`
