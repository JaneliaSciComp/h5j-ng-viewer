// How finely the 3D projection samples the volume.
//
// Neuroglancer calls this `volumeRenderingDepthSamples`, and it does two jobs at once:
// it is the number of samples taken along each ray, AND it is handed to the backend as
// the volume-rendering `renderScaleTarget`, which is what selects the pyramid level the
// projection reads. That second job is why the low end still looks blocky at
// Neuroglancer's own default of 64 -- a volume over a thousand voxels deep resolves to
// one of the coarsest levels.
//
// The steps are powers of two because the effect is logarithmic: each one halves the
// distance between samples and moves at most one pyramid level. A linear slider over the
// same span would spend most of its travel on differences nobody can see.

/**
 * The ladder the slider moves along, coarsest first.
 *
 * The top end is past the point where a finer pyramid level exists for a typical aligned
 * stack, and it still earns its cost: maximum-intensity projection reports the brightest
 * sample it happens to take, so a ray that steps over a thin bright process misses it
 * entirely. More samples means fewer such misses, which shows up as thin structures that
 * stop flickering as the camera moves.
 *
 * Cost is linear in this number, and it is paid per pixel of the 3D panel.
 */
export const PROJECTION_SAMPLE_STEPS = [512, 1024, 2048, 4096, 8192] as const

/** Where the slider starts: the coarsest step, which is the cheapest. */
export const DEFAULT_PROJECTION_SAMPLES = PROJECTION_SAMPLE_STEPS[0]

/**
 * Neuroglancer's own bounds. Worth stating because of how it fails: the trackable's
 * `restoreState` runs a range validator and, on a throw, falls back to ITS default of
 * 64 -- so an out-of-range value here would silently come back as the blockiest setting
 * rather than as an error.
 */
export const PROJECTION_SAMPLE_LIMITS = { min: 2, max: 2 ** 21 - 1 }

/** Samples for a slider position, clamped so a stale index cannot read undefined. */
export function samplesForStep(step: number): number {
  const clamped = Math.min(
    Math.max(Math.round(step), 0),
    PROJECTION_SAMPLE_STEPS.length - 1
  )
  return PROJECTION_SAMPLE_STEPS[clamped]
}

/**
 * Slider position for a sample count -- the nearest step at or below it, so a value
 * saved by a future build with a longer ladder still puts the handle somewhere sensible
 * rather than at zero.
 */
export function stepForSamples(samples: number): number {
  let step = 0
  for (let i = 0; i < PROJECTION_SAMPLE_STEPS.length; i += 1) {
    if (PROJECTION_SAMPLE_STEPS[i] <= samples) step = i
  }
  return step
}

/** Compact enough for a 32px bar: "512", "1k", "8k". */
export function formatSamples(samples: number): string {
  return samples < 1024 ? String(samples) : `${samples / 1024}k`
}
