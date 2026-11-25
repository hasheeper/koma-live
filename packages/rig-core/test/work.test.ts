import { describe, expect, it } from 'vitest'
import {
  assertStandalonePerformanceSource,
  computeFixedSteps,
  computeLayerPixelScale,
  computeViewportLayout,
  createErrorGate,
  mapClientToLogicalPointer,
  performanceMetaSchema,
  workManifestSchema,
} from '../src/index.js'

describe('koma-rig.work.v1 & performance.v1 contract schemas', () => {
  it('validates portable work manifest and defaults', () => {
    const parsed = workManifestSchema.parse({
      format: 'koma-rig.work.v1',
      id: 'lutie-human',
      title: '露缇 · 人形态',
      rig: './assets/slices/',
      performance: './motion/lutie-live.js',
      poster: './assets/slices/reference.png',
      viewport: { fit: 'contain', anchor: [0.5, 1] },
      defaultState: 'idle',
    })
    expect(parsed.id).toBe('lutie-human')
    expect(parsed.viewport?.anchor).toEqual([0.5, 1])

    expect(() =>
      workManifestSchema.parse({
        format: 'koma-rig.work.v1',
        id: 'bad',
        rig: './',
        extraField: true,
      }),
    ).toThrow()
  })

  it('validates performance meta with 2d coaxial layer slots only', () => {
    const meta = performanceMetaSchema.parse({
      format: 'koma-rig.performance.v1',
      title: 'Living Idle',
      states: ['idle', 'happy'],
      triggers: ['tap'],
      layers: { back: '2d', front: false },
    })
    expect(meta.layers?.back).toBe('2d')

    expect(() =>
      performanceMetaSchema.parse({
        format: 'koma-rig.performance.v1',
        layers: { front: 'webgl' },
      }),
    ).toThrow()
  })
})

describe('coaxial viewport layout & logical pointer mapping', () => {
  it('computes contain/cover scale and bottom-center anchor without drift', () => {
    const bottomCenter = computeViewportLayout(400, 600, 1000, 1000, {
      fit: 'contain',
      anchor: [0.5, 1],
      paddingPx: 20,
    })
    expect(bottomCenter.scale).toBeCloseTo(0.36, 6)
    expect(bottomCenter.width).toBeCloseTo(360, 6)
    expect(bottomCenter.height).toBeCloseTo(360, 6)
    expect(bottomCenter.offsetX).toBeCloseTo(20, 6)
    expect(bottomCenter.offsetY).toBeCloseTo(600 - 20 - 360, 6)

    const cover = computeViewportLayout(600, 300, 1000, 1000, { fit: 'cover' })
    expect(cover.scale).toBeCloseTo(0.6, 6)
    expect(cover.offsetX).toBeCloseTo(0, 6)
    expect(cover.offsetY).toBeCloseTo(-150, 6)
  })

  it('maps screen pointer back to manifest.canvas logical pixels accurately', () => {
    const center = mapClientToLogicalPointer(280, 340, 100, 160, 360, 360, 1000, 1000, true)
    expect(center.inside).toBe(true)
    expect(center.down).toBe(true)
    expect(center.x).toBeCloseTo(500, 6)
    expect(center.y).toBeCloseTo(500, 6)
    expect(center.nx).toBeCloseTo(0, 6)
    expect(center.ny).toBeCloseTo(0, 6)

    const outside = mapClientToLogicalPointer(50, 160, 100, 160, 360, 360, 1000, 1000, false)
    expect(outside.inside).toBe(false)
    expect(outside.x).toBeLessThan(0)
    expect(outside.nx).toBeLessThan(-1)
  })
})

describe('contract guardrails 1-4', () => {
  it('Guardrail 1: rejects external imports while allowing comments and string literals', () => {
    expect(() =>
      assertStandalonePerformanceSource(`
        // import ignored from './comment.js'
        const doc = "never call import('./nope.js') here"
        export const meta = { format: 'koma-rig.performance.v1' }
        export default function createPerformance() { return { update() {} } }
      `),
    ).not.toThrow()

    expect(() =>
      assertStandalonePerformanceSource(`import { spring } from './spring.js'\nexport default () => ({ update() {} })`),
    ).toThrow(/单文件自包含/)

    expect(() =>
      assertStandalonePerformanceSource(`import './side-effect.js'\nexport default () => ({ update() {} })`),
    ).toThrow(/单文件自包含/)

    expect(() =>
      assertStandalonePerformanceSource(`export * from './other.js'`),
    ).toThrow(/单文件自包含/)

    expect(() =>
      assertStandalonePerformanceSource(`export default async () => { await import('./lazy.js'); return { update() {} } }`),
    ).toThrow(/单文件自包含/)
  })

  it('Guardrail 2: generates deterministic fixed steps summing exactly to targetTimeMs', () => {
    expect(computeFixedSteps(0, 10)).toEqual([{ timeMs: 0, dtMs: 0 }])

    const exact = computeFixedSteps(30, 10)
    expect(exact).toEqual([
      { timeMs: 10, dtMs: 10 },
      { timeMs: 20, dtMs: 10 },
      { timeMs: 30, dtMs: 10 },
    ])

    const withRemainder = computeFixedSteps(35.5, 10)
    expect(withRemainder).toHaveLength(4)
    expect(withRemainder.at(-1)?.timeMs).toBe(35.5)
    expect(withRemainder.at(-1)?.dtMs).toBeCloseTo(5.5, 6)
    const totalDt = withRemainder.reduce((sum, s) => sum + s.dtMs, 0)
    expect(totalDt).toBeCloseTo(35.5, 6)

    expect(() => computeFixedSteps(-1, 10)).toThrow()
    expect(() => computeFixedSteps(10, 0)).toThrow()
  })

  it('Guardrail 3: computes 2D backing pixelScale with DPR, displayScale, maxDpr and maxSidePx caps', () => {
    // 512x512 canvas shown 1:1 on 2x Retina -> 2x backing pixels
    expect(computeLayerPixelScale(2, 1, 512, 512, 2, 4096)).toBe(2)
    // 1024x1536 canvas shrunk to 360x540 card on 2x Retina -> 0.7 clamped to 1 (already crisp)
    expect(computeLayerPixelScale(2, 0.35, 1024, 1536, 2, 4096)).toBe(1)
    // Zoomed up 3x on 2x Retina -> capped by maxDpr=2
    expect(computeLayerPixelScale(2, 3, 512, 512, 2, 4096)).toBe(2)
    // Huge 3000x3000 canvas -> bounded by maxSidePx=4096 (~1.365)
    expect(computeLayerPixelScale(2, 1, 3000, 3000, 2, 4096)).toBeCloseTo(4096 / 3000, 6)
    // Half-resolution 2D layer scale cuts fill-rate by 75% while preserving logical coordinates
    expect(computeLayerPixelScale(2, 0.35, 1024, 1536, 2, 4096, 0.5)).toBe(0.5)
    expect(computeLayerPixelScale(2, 1, 512, 512, 2, 4096, 0.5)).toBe(1)
  })

  it('Guardrail 4: error gate auto-pauses once or deduplicates/throttles identical errors', () => {
    const pauseGate = createErrorGate('pause')
    const err = new Error('三角形 3 翻面或退化')
    expect(pauseGate.report(err, 100)).toEqual({ notify: true, shouldPause: true })
    expect(pauseGate.report(err, 116)).toEqual({ notify: false, shouldPause: true })
    pauseGate.clear()
    expect(pauseGate.report(err, 500)).toEqual({ notify: true, shouldPause: true })

    const throttleGate = createErrorGate('throttle', 1000)
    expect(throttleGate.report(err, 100)).toEqual({ notify: true, shouldPause: false })
    expect(throttleGate.report(new Error('三角形 3 翻面或退化'), 116)).toEqual({
      notify: false,
      shouldPause: false,
    })
    expect(throttleGate.report(new Error('另一个错误'), 200)).toEqual({
      notify: true,
      shouldPause: false,
    })
    expect(throttleGate.report(new Error('另一个错误'), 1201)).toEqual({
      notify: true,
      shouldPause: false,
    })
  })
})
