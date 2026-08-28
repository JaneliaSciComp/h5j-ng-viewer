import { describe, expect, it } from "vitest"
import {
  DEFAULT_PROJECTION_SAMPLES,
  formatSamples,
  PROJECTION_SAMPLE_LIMITS,
  PROJECTION_SAMPLE_STEPS,
  samplesForStep,
  stepForSamples,
} from "@/lib/projection"

describe("the sample ladder", () => {
  it("goes coarse to fine, so the slider reads left to right", () => {
    for (let i = 1; i < PROJECTION_SAMPLE_STEPS.length; i += 1) {
      expect(PROJECTION_SAMPLE_STEPS[i]).toBeGreaterThan(
        PROJECTION_SAMPLE_STEPS[i - 1]
      )
    }
  })

  it("doubles at every step, because the effect is logarithmic", () => {
    // Each step halves the distance between samples and moves at most one pyramid
    // level. Linear steps would spend most of the travel on invisible differences.
    for (let i = 1; i < PROJECTION_SAMPLE_STEPS.length; i += 1) {
      expect(PROJECTION_SAMPLE_STEPS[i]).toBe(
        PROJECTION_SAMPLE_STEPS[i - 1] * 2
      )
    }
  })

  it("stays inside Neuroglancer's range at both ends", () => {
    // Outside it, the trackable's validator throws, restoreState swallows the throw, and
    // the value reverts to Neuroglancer's default of 64 -- silently landing on the
    // blockiest setting, which is exactly what a detail control must never do.
    for (const samples of PROJECTION_SAMPLE_STEPS) {
      expect(samples).toBeGreaterThanOrEqual(PROJECTION_SAMPLE_LIMITS.min)
      expect(samples).toBeLessThanOrEqual(PROJECTION_SAMPLE_LIMITS.max)
    }
  })

  it("starts at the cheapest step", () => {
    expect(DEFAULT_PROJECTION_SAMPLES).toBe(PROJECTION_SAMPLE_STEPS[0])
  })

  it("is finer than Neuroglancer's own default even at its coarsest", () => {
    // 64 is what makes the projection blocky in the first place, so the low end of this
    // slider has to be well above it rather than reproducing it.
    expect(DEFAULT_PROJECTION_SAMPLES).toBeGreaterThan(64)
  })
})

describe("samplesForStep", () => {
  it("maps each slider position to its step", () => {
    PROJECTION_SAMPLE_STEPS.forEach((samples, step) => {
      expect(samplesForStep(step)).toBe(samples)
    })
  })

  it("clamps a position off either end rather than reading undefined", () => {
    const last = PROJECTION_SAMPLE_STEPS.length - 1
    expect(samplesForStep(-1)).toBe(PROJECTION_SAMPLE_STEPS[0])
    expect(samplesForStep(99)).toBe(PROJECTION_SAMPLE_STEPS[last])
  })

  it("rounds a fractional position", () => {
    expect(samplesForStep(1.4)).toBe(PROJECTION_SAMPLE_STEPS[1])
    expect(samplesForStep(1.6)).toBe(PROJECTION_SAMPLE_STEPS[2])
  })
})

describe("stepForSamples", () => {
  it("round-trips every step", () => {
    PROJECTION_SAMPLE_STEPS.forEach((samples, step) => {
      expect(stepForSamples(samples)).toBe(step)
    })
  })

  it("takes the nearest step at or below a value between two", () => {
    expect(stepForSamples(3000)).toBe(2)
    expect(samplesForStep(stepForSamples(3000))).toBe(2048)
  })

  it("puts a value below the ladder at the first step, not off the slider", () => {
    expect(stepForSamples(1)).toBe(0)
    expect(stepForSamples(64)).toBe(0)
  })

  it("puts a value above the ladder at the last step", () => {
    // Reachable if a saved value came from a build with a longer ladder; the handle must
    // still land somewhere sensible.
    expect(stepForSamples(1e9)).toBe(PROJECTION_SAMPLE_STEPS.length - 1)
  })
})

describe("formatSamples", () => {
  it("stays short enough for a 32px bar", () => {
    for (const samples of PROJECTION_SAMPLE_STEPS) {
      expect(formatSamples(samples).length).toBeLessThanOrEqual(4)
    }
  })

  it("spells out below 1024 and abbreviates above", () => {
    expect(formatSamples(512)).toBe("512")
    expect(formatSamples(1024)).toBe("1k")
    expect(formatSamples(8192)).toBe("8k")
  })
})
