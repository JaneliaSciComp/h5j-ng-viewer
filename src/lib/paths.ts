// OPFS layout, mirroring the URL paths the service worker serves so that no
// translation is needed beyond stripping the leading slash:
//
//   zarr/<datasetId>/c<channel>/.zgroup
//   zarr/<datasetId>/c<channel>/.zattrs
//   zarr/<datasetId>/c<channel>/<level>/.zarray
//   zarr/<datasetId>/c<channel>/<level>/index.json    -> LevelIndex
//   zarr/<datasetId>/c<channel>/<level>/chunks.bin    -> every chunk, packed

export const ZARR_ROOT = "zarr"

/** URL prefix the service worker intercepts. Keep in sync with public/sw.js. */
export const ZARR_URL_PREFIX = `/${ZARR_ROOT}/`

export const datasetPath = (datasetId: string) => `${ZARR_ROOT}/${datasetId}`

/**
 * One OME-Zarr group per channel, each a plain three-dimensional volume.
 *
 * A single array spanning the channel axis would be fewer files, and was the layout until
 * it proved incompatible with showing one channel while another converts: a chunk holding
 * every channel is only correct once the last of them has been written, and Neuroglancer
 * caches what it has already fetched. Per channel, a chunk is complete the moment it is
 * written, and a channel's chunks are only ever fetched by that channel's own layer.
 */
export const channelPath = (datasetId: string, channel: number) =>
  `${datasetPath(datasetId)}/c${channel}`

export const levelPath = (
  datasetId: string,
  channel: number,
  level: number
) => `${channelPath(datasetId, channel)}/${level}`

export const zgroupPath = (datasetId: string, channel: number) =>
  `${channelPath(datasetId, channel)}/.zgroup`

export const zattrsPath = (datasetId: string, channel: number) =>
  `${channelPath(datasetId, channel)}/.zattrs`

export const zarrayPath = (datasetId: string, channel: number, level: number) =>
  `${levelPath(datasetId, channel, level)}/.zarray`

export const levelIndexPath = (
  datasetId: string,
  channel: number,
  level: number
) => `${levelPath(datasetId, channel, level)}/index.json`

/**
 * Every chunk of one level of one channel, packed contiguously in chunk-grid order
 * (z outer, then y, then x). A chunk's offset is therefore a single multiply, which the
 * service worker recomputes; it cannot import from here, being dependency-free plain JS.
 */
export const chunksFilePath = (
  datasetId: string,
  channel: number,
  level: number
) => `${levelPath(datasetId, channel, level)}/chunks.bin`
