import { describe, expect, it } from 'vitest'
import { buildAutoHeadMorphs, sliceManifestSchema } from '../src/index.js'
import base from '../../../tests/fixtures/chain-strip/manifest.json'

const manifest = sliceManifestSchema.parse({
  ...base,
  canvas: { width: 1000, height: 1200 },
  layers: [
    { ...base.layers[0], layerId: 'face_base', rect: [300, 260, 400, 360] },
    { ...base.layers[0], layerId: 'pupil', rect: [380, 430, 240, 64] },
    { ...base.layers[0], layerId: 'brow', rect: [400, 410, 200, 18] },
    { ...base.layers[0], layerId: 'expr_eyes', rect: [330, 400, 340, 100] },
    { ...base.layers[0], layerId: 'ear_l', rect: [295, 420, 60, 84] },
    { ...base.layers[0], layerId: 'ear_r', rect: [645, 420, 60, 84] },
    { ...base.layers[0], layerId: 'hair_crown', rect: [230, 90, 540, 340] },
    { ...base.layers[0], layerId: 'bang_c', rect: [400, 140, 280, 420] },
    { ...base.layers[0], layerId: 'sideburn_r', rect: [560, 140, 380, 520] },
    { ...base.layers[0], layerId: 'ahoge_top', rect: [440, 20, 120, 90] },
    { ...base.layers[0], layerId: 'highlight_r', rect: [407, 455, 10, 9] },
    { ...base.layers[0], layerId: 'torso', rect: [320, 620, 360, 480] },
  ],
})

const config = {
  format: 'koma-rig.auto-head.v1',
  geometry: {
    faceLayer: 'face_base',
    faceCenterX: 500,
    neckAnchor: [500, 620],
    eyeCenters: [
      [412, 460],
      [588, 460],
    ],
  },
  layers: {
    face_base: { role: 'face', grid: [12, 10] },
    pupil: { role: 'face', grid: [8, 3] },
    brow: { role: 'face', grid: [12, 2] },
    expr_eyes: {
      role: 'face',
      grid: [10, 4],
      eyePairCenters: [
        [412, 460],
        [588, 460],
      ],
    },
    ear_l: { role: 'ear', grid: [4, 4] },
    ear_r: { role: 'ear', grid: [4, 4] },
    hair_crown: { role: 'crown', grid: [8, 6] },
    bang_c: { role: 'front_bang', grid: [6, 8] },
    sideburn_r: { role: 'sideburn', grid: [6, 8] },
    ahoge_top: { role: 'ahoge', followPoint: [480, 110] },
    highlight_r: { role: 'face' },
  },
} as const

describe('buildAutoHeadMorphs (bounded 3D ellipsoidal anime skull)', () => {
  it('produces exact neutral, strict L/R symmetry, convex 3D midline (no chin shear), and bounded wide-hair motion', () => {
    const res = buildAutoHeadMorphs(manifest, config)
    expect(res.morphs).toHaveLength(11)
    expect(res.neckAnchor).toEqual([500, 620])
    expect(res.pinNeck).toBe(false)
    expect(res.diagnostics.maxSymmetryErrorPx).toBeLessThan(1e-3)
    expect(res.diagnostics.minJacobian).toBeGreaterThanOrEqual(0.75)

    for (const m of res.morphs) {
      expect(m.deltas[4]).toBeNull()
    }

    // True convex 3D midline (nose peaks ahead of forehead & chin; chin tracks mouth without shear!)
    const { yawMetrics, pitchMetrics } = res.diagnostics
    expect(yawMetrics.noseDxPx).toBeGreaterThan(yawMetrics.foreheadDxPx)
    expect(yawMetrics.noseDxPx).toBeGreaterThan(10)
    expect(yawMetrics.mouthDxPx).toBeGreaterThan(9)
    expect(yawMetrics.chinDxPx).toBeGreaterThan(8)
    expect(yawMetrics.mouthDxPx - yawMetrics.chinDxPx).toBeLessThan(3)

    // Near cheek expands & far cheek/temple foreshorten cleanly
    expect(yawMetrics.mouthDxPx).toBeGreaterThan(yawMetrics.nearCheekDxPx)
    expect(yawMetrics.mouthDxPx - yawMetrics.farCheekDxPx).toBeGreaterThan(9)
    expect(yawMetrics.farTempleDxPx).toBeLessThan(2)
    expect(yawMetrics.farEyeWidthPct).toBeLessThan(-5)
    expect(yawMetrics.nearEyeWidthPct).toBeGreaterThan(-1)
    expect(yawMetrics.nearEyeWidthPct).toBeLessThan(5.5)

    // Hair parallax hierarchy: front_bang > sideburn > crown > 0, ear behind face
    expect(yawMetrics.frontBangParallaxPx!).toBeGreaterThan(yawMetrics.sideburnParallaxPx!)
    expect(yawMetrics.sideburnParallaxPx!).toBeGreaterThan(0.5)
    expect(yawMetrics.crownParallaxPx!).toBeGreaterThan(0.3)
    expect(yawMetrics.earParallaxPx!).toBeLessThan(-2)

    // Wide sideburn extending past u > 2 must stay smoothly bounded (no -20/-30px collapse)
    const sideburn = res.morphs.find((m) => m.layerId === 'sideburn_r')!
    const sbRightDx = sideburn.deltas[5]!.filter((_, i) => i % 2 === 0)
    expect(Math.min(...sbRightDx)).toBeGreaterThan(-10)

    // Crown rotates cohesively without sliding wildly or peeling off back hair
    const crown = res.morphs.find((m) => m.layerId === 'hair_crown')!
    const crownRightDx = crown.deltas[5]!.filter((_, i) => i % 2 === 0)
    expect(Math.min(...crownRightDx)).toBeGreaterThan(-8)

    // Both Pitch UP and Pitch DOWN deliver real 3D vertical elevation & foreshortening
    expect(pitchMetrics.upEyeDyPx).toBeLessThan(-6)
    expect(pitchMetrics.upChinDyPx).toBeLessThan(-6)
    expect(Math.abs(pitchMetrics.upForeheadDyPx)).toBeLessThan(Math.abs(pitchMetrics.upEyeDyPx))
    expect(pitchMetrics.downForeheadDyPx).toBeGreaterThan(8)
    expect(pitchMetrics.downEyeDyPx).toBeGreaterThan(7)
    expect(pitchMetrics.downChinDyPx).toBeLessThan(pitchMetrics.downEyeDyPx)
  })

  it('deforms wide thin strips (brow), preserves 3D curvature without vertical squash on paired eyes, and keeps tiny dots rigid', () => {
    const res = buildAutoHeadMorphs(manifest, config)

    // Wide thin brow strip (200x18) must deform smoothly across both eyes (NOT rigid center-follow!)
    const brow = res.morphs.find((m) => m.layerId === 'brow')!
    const browR = brow.deltas[5]!
    const leftBrowDx = browR[0]!
    const rightBrowDx = browR[brow.grid[0] * 2]!
    expect(Math.abs(leftBrowDx - rightBrowDx)).toBeGreaterThan(3)

    // Paired expression eyes: zero internal vertical squash (dy constant per column) while preserving 3D slopeY across width
    const expr = res.morphs.find((m) => m.layerId === 'expr_eyes')!
    const cols = expr.grid[0]
    const stride = (cols + 1) * 2
    for (const slot of [1, 2, 7]) {
      const d = expr.deltas[slot]!
      for (let i = 0; i <= cols; i++) {
        const topDy = d[i * 2 + 1]!
        const botDy = d[expr.grid[1] * stride + i * 2 + 1]!
        expect(Math.abs(botDy - topDy)).toBeLessThan(1e-4)
      }
    }
    // In Pitch UP (slot 1), inner eye lifts gently more than outer eye corner without caret shear (< 2px)
    const exprUp = expr.deltas[1]!
    const outerUpDy = exprUp[1]!
    const innerUpDy = exprUp[Math.floor(cols / 2) * 2 + 1]!
    expect(innerUpDy).toBeLessThan(outerUpDy - 0.3)
    expect(outerUpDy - innerUpDy).toBeLessThan(2.5)

    // In diagonal UR (slot 2), paired eyes must NOT overshoot face center or bend > 2.5px across one eye
    const exprUR = expr.deltas[2]!
    const urLeftDy = exprUR[1]!
    const urMidDx = exprUR[Math.floor(cols / 2) * 2]!
    const urRightDy = exprUR[cols * 2 + 1]!
    expect(urMidDx).toBeLessThan(res.diagnostics.yawMetrics.noseDxPx + 2)
    expect(Math.abs(urLeftDy - urRightDy)).toBeLessThan(3.0)

    // FollowPoint ahoge translates rigidly
    const ahoge = res.morphs.find((m) => m.layerId === 'ahoge_top')!
    const ahogeR = ahoge.deltas[5]!
    for (let k = 2; k < ahogeR.length; k += 2) {
      expect(ahogeR[k]).toBeCloseTo(ahogeR[0]!, 4)
      expect(ahogeR[k + 1]).toBeCloseTo(ahogeR[1]!, 4)
    }

    // Tiny 2D dot/highlight layers (BOTH w and h <= 24) auto-translate rigidly (Jacobian === 1)
    const hi = res.morphs.find((m) => m.layerId === 'highlight_r')!
    expect(hi.grid).toEqual([1, 1])
    const hiD = hi.deltas[7]!
    for (let k = 2; k < hiD.length; k += 2) {
      expect(hiD[k]).toBeCloseTo(hiD[0]!, 4)
      expect(hiD[k + 1]).toBeCloseTo(hiD[1]!, 4)
    }
  })

  it('supports pinNeck mode for unsplit face+neck sprites and rejects invalid config inputs', () => {
    const pinned = buildAutoHeadMorphs(manifest, {
      ...config,
      geometry: { ...config.geometry, pinNeck: true },
    })
    expect(pinned.pinNeck).toBe(true)
    expect(pinned.diagnostics.maxSymmetryErrorPx).toBeLessThan(1e-3)
    expect(Math.abs(pinned.diagnostics.yawMetrics.chinDxPx)).toBeLessThan(1e-3)

    expect(() =>
      buildAutoHeadMorphs(manifest, { ...config, geometry: { faceLayer: 'missing' } }),
    ).toThrow(/未知脸部图层/)
    expect(() =>
      buildAutoHeadMorphs(manifest, {
        ...config,
        parameters: { yaw: { id: 'same', deg: 12 }, pitch: { id: 'same', upDeg: 5, downDeg: 10 } },
      }),
    ).toThrow(/不同参数/)
    expect(() =>
      buildAutoHeadMorphs(manifest, {
        ...config,
        adjustments: { torso: { right: [2, 0] } },
      }),
    ).toThrow(/未知微调图层/)
  })

  it('sculpts recessed eye sockets, protruding nose/brow parallax, and spherical crown dome roll without crushing far eye', () => {
    const sculpted = buildAutoHeadMorphs(manifest, {
      ...config,
      parameters: { yaw: { id: 'headYaw', deg: 21 }, pitch: { id: 'headPitch', upDeg: 12.5, downDeg: 17.5 } },
      geometry: {
        ...config.geometry,
        headDepthRatio: 0.42,
        skullSwingRatio: 0.06,
        faceRelief: 0.55,
        crownDome: 0.95,
      },
      layers: {
        ...config.layers,
        pupil: { role: 'face', zRatio: -0.065, grid: [8, 3] },
        brow: { role: 'face', zRatio: 0.045, grid: [12, 2] },
        expr_eyes: {
          role: 'face',
          rootZRatio: 0.025,
          tipZRatio: -0.055,
          grid: [10, 4],
          eyePairCenters: [
            [412, 460],
            [588, 460],
          ],
        },
      },
    })

    expect(sculpted.diagnostics.maxSymmetryErrorPx).toBeLessThan(1e-3)
    expect(sculpted.diagnostics.minJacobian).toBeGreaterThanOrEqual(0.40)
    // Far eye must foreshorten gracefully without getting crushed into a narrow slit!
    expect(sculpted.diagnostics.yawMetrics.farEyeWidthPct).toBeLessThan(-12)
    expect(sculpted.diagnostics.yawMetrics.farEyeWidthPct).toBeGreaterThan(-30)

    // Recessed pupil lags visibly behind protruding brow ridge on Yaw RIGHT (true orbital depth!)
    const pupil = sculpted.morphs.find((m) => m.layerId === 'pupil')!
    const brow = sculpted.morphs.find((m) => m.layerId === 'brow')!
    const midIdx = (Math.floor(pupil.grid[0] / 2) + (pupil.grid[0] + 1)) * 2
    const browMidIdx = Math.floor(brow.grid[0] / 2) * 2
    expect(brow.deltas[5]![browMidIdx]!).toBeGreaterThan(pupil.deltas[5]![midIdx]! + 5)

    // Composite paired eyes keep zero vertical squash while gaining upper-lash-over-iris Yaw parallax!
    const expr = sculpted.morphs.find((m) => m.layerId === 'expr_eyes')!
    const cols = expr.grid[0]
    const stride = (cols + 1) * 2
    const c = Math.floor(cols / 2)
    expect(Math.abs(expr.deltas[7]![expr.grid[1] * stride + c * 2 + 1]! - expr.deltas[7]![c * 2 + 1]!)).toBeLessThan(1e-4)
    expect(expr.deltas[5]![c * 2]!).toBeGreaterThan(expr.deltas[5]![expr.grid[1] * stride + c * 2]! + 3)

    // Spherical crown dome holds round outer arch (no boxy corners!) while whorl rolls boldly in Pitch & Yaw!
    const crown = sculpted.morphs.find((m) => m.layerId === 'hair_crown')!
    const cCols = crown.grid[0]
    const cStride = (cCols + 1) * 2
    const topMidIdx = Math.floor(cCols / 2) * 2
    const whorlMidIdx = 2 * cStride + Math.floor(cCols / 2) * 2
    expect(Math.abs(crown.deltas[7]![topMidIdx + 1]!)).toBeLessThan(6)
    expect(crown.deltas[7]![whorlMidIdx + 1]! - crown.deltas[7]![topMidIdx + 1]!).toBeGreaterThan(18)
    // And in Yaw RIGHT, the hair whorl rotates cleanly ahead of the round outer top arch!
    expect(crown.deltas[5]![whorlMidIdx]! - crown.deltas[5]![topMidIdx]!).toBeGreaterThan(15)
  })
})
