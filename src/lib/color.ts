// Conversions between the hex the rest of the app speaks and the hue/saturation/value a
// picker needs. Pure, so the fiddly part is testable without a browser.

export interface Hsv {
  /** 0..360; meaningless when saturation is 0, and preserved rather than reset. */
  h: number
  /** 0..1 */
  s: number
  /** 0..1 */
  v: number
}

/** Parse `#rrggbb`, tolerating a missing hash and any case. Null when unparseable. */
export function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, "0")
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`
}

/**
 * Hue, saturation and value for a hex color. Grays have no hue to speak of, so this
 * reports 0 for them -- a caller that is tracking a hue slider should keep the hue it
 * already had rather than snapping the slider to red when the user drags to the gray
 * edge of the square.
 */
export function hexToHsv(hex: string): Hsv {
  const rgb = parseHex(hex)
  if (!rgb) return { h: 0, s: 0, v: 0 }
  const [r, g, b] = rgb.map((channel) => channel / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min

  let h = 0
  if (span !== 0) {
    if (max === r) h = ((g - b) / span) % 6
    else if (max === g) h = (b - r) / span + 2
    else h = (r - g) / span + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : span / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360
  const saturation = Math.max(0, Math.min(1, s))
  const value = Math.max(0, Math.min(1, v))

  const chroma = value * saturation
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = value - chroma
  const sector = Math.floor(hue / 60) % 6
  const [r, g, b] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ][sector]
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

/** One channel replaced, the others left alone. */
export function setChannel(
  hex: string,
  channel: "r" | "g" | "b",
  value: number
): string {
  const rgb = parseHex(hex) ?? [0, 0, 0]
  const index = { r: 0, g: 1, b: 2 }[channel]
  rgb[index] = value
  return rgbToHex(rgb[0], rgb[1], rgb[2])
}
