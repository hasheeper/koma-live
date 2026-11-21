import { describe, expect, it } from 'vitest'
import {
  GeometryError,
  createRig,
  editRig,
  emptyRig,
  meshFromAlpha,
  sliceManifestSchema,
  subdivideContourGrid,
  restMesh,
  transform,
} from '../src/index.js'

function makeMultiLayerFixture() {
  const manifest = sliceManifestSchema.parse({
    format: 'koma-rig.slices.v2',
    sourceId: 'mesh-field-fixture',
    blendSpace: 'srgb',
    canvas: { width: 400, height: 400 },
    reference: 'reference.png',
    layers: [
      // Two differently-cropped layers overlapping at canvas (200, 120) for cross-layer phase sync tests
      { layerId: 'bell_back', name: '伞盖后', groups: [], texture: 'textures/0.png', rect: [80, 60, 240, 140], visible: true, opacity: 1 },
      { layerId: 'bell_front', name: '伞盖前', groups: [], texture: 'textures/1.png', rect: [100, 40, 200, 120], visible: true, opacity: 1 },
      // Single-bone rigid layer
      { layerId: 'ribbon', name: '丝带', groups: [], texture: 'textures/2.png', rect: [160, 180, 40, 160], visible: true, opacity: 1 },
      // Bone-chain layer
      { layerId: 'tentacle', name: '触须', groups: [], texture: 'textures/3.png', rect: [240, 180, 40, 160], visible: true, opacity: 1 },
    ],
  })

  const rig = editRig(manifest, emptyRig(manifest.sourceId), [
    { op: 'add-bone', boneId: 'root', name: '根', start: [200, 120], end: [200, 180] },
    { op: 'add-bone', boneId: 'ribbon_b', name: '丝带骨', start: [180, 180], end: [180, 320], parentBoneId: 'root', snap: false },
    { op: 'add-bone', boneId: 't1', name: '触须1', start: [260, 180], end: [260, 260], parentBoneId: 'root', snap: false },
    { op: 'add-bone', boneId: 't2', name: '触须2', start: [260, 260], end: [260, 340], parentBoneId: 't1' },
    { op: 'bind', layerId: 'bell_back', boneId: 'root' },
    { op: 'bind', layerId: 'bell_front', boneId: 'root' },
    { op: 'bind', layerId: 'ribbon', boneId: 'ribbon_b' },
    { op: 'bind-chain', layerId: 'tentacle', boneChain: ['t1', 't2'], jointSoftnessPx: 32 },
  ])
  return { manifest, rig }
}

describe('M4 Mesh Field (code-native procedural vertex deformation)', () => {
  it('passes exact original canvas rest (x, y) so differently cropped layers stay phase-locked', () => {
    const { manifest, rig } = makeMultiLayerFixture()
    const model = createRig(manifest, rig)

    const samples = new Map<string, Array<{ u: number; v: number; x: number; y: number }>>()
    const wave = (layerId: string) => (u: number, v: number, x: number, y: number) => {
      if (!samples.has(layerId)) samples.set(layerId, [])
      samples.get(layerId)!.push({ u, v, x, y })
      return [Math.sin(x * 0.04) * 5, Math.cos(y * 0.04) * 4] as const
    }

    const pose = model.pose(undefined, undefined, undefined, 0, {}, {}, {
      bell_back: { grid: [6, 7], field: wave('bell_back') },
      bell_front: { grid: [4, 6], field: wave('bell_front') },
    })

    // Verify (x, y) === (rect.x + u * rect.w, rect.y + v * rect.h) for every sampled vertex
    for (const layerId of ['bell_back', 'bell_front'] as const) {
      const layer = manifest.layers.find((l) => l.layerId === layerId)!
      const pts = samples.get(layerId)!
      expect(pts.length).toBeGreaterThan(20)
      for (const p of pts) {
        expect(p.x).toBeCloseTo(layer.rect[0] + p.u * layer.rect[2], 9)
        expect(p.y).toBeCloseTo(layer.rect[1] + p.v * layer.rect[3], 9)
      }
    }

    // Both grids contain a vertex at exact canvas point (200, 100):
    // bell_back: rect [80, 60, 240, 140] -> u = 120/240 = 0.5, v = 40/140 = 2/7
    // bell_front: rect [100, 40, 200, 120] -> u = 100/200 = 0.5, v = 60/120 = 0.5
    const backPart = pose.parts.find((p) => p.layerId === 'bell_back')!
    const frontPart = pose.parts.find((p) => p.layerId === 'bell_front')!
    const findWorldAt = (part: typeof backPart, targetU: number, targetV: number) => {
      const g = part.geometry!
      for (let i = 0; i < g.uv.length; i += 2) {
        if (Math.abs(g.uv[i]! - targetU) < 1e-6 && Math.abs(g.uv[i + 1]! - targetV) < 1e-6) {
          return transform(part.matrix, g.vertices[i]!, g.vertices[i + 1]!)
        }
      }
      throw new Error('target UV not found')
    }
    const worldBack = findWorldAt(backPart, 0.5, 2 / 7)
    const worldFront = findWorldAt(frontPart, 0.5, 0.5)
    expect(worldBack[0]).toBeCloseTo(worldFront[0], 6)
    expect(worldBack[1]).toBeCloseTo(worldFront[1], 6)
    expect(worldBack[0]).toBeCloseTo(200 + Math.sin(200 * 0.04) * 5, 6)
    expect(worldBack[1]).toBeCloseTo(100 + Math.cos(100 * 0.04) * 4, 6)
  })

  it('applies rest-space [dx, dy] BEFORE both single-bone rigid transform and boneChain skinning', () => {
    const { manifest, rig } = makeMultiLayerFixture()
    const model = createRig(manifest, rig)

    // Rotate single-bone ribbon_b by +90 deg clockwise around pivot (180, 180)
    // A rest-space local offset (+10, 0) must rotate to canvas (0, +10)!
    const poseBase = model.pose(undefined, undefined, undefined, 0, {}, { ribbon_b: { rotation: 90 } })
    const poseField = model.pose(
      undefined,
      undefined,
      undefined,
      0,
      {},
      { ribbon_b: { rotation: 90 } },
      { ribbon: { grid: [2, 4], field: () => [10, 0] } },
    )
    const basePart = poseBase.parts.find((p) => p.layerId === 'ribbon')!
    const fieldPart = poseField.parts.find((p) => p.layerId === 'ribbon')!
    // Check top-left local corner (0, 0) mapped to world space
    const baseCorner = transform(basePart.matrix, 0, 0)
    const fieldCorner = transform(fieldPart.matrix, fieldPart.geometry!.vertices[0]!, fieldPart.geometry!.vertices[1]!)
    expect(fieldCorner[0] - baseCorner[0]).toBeCloseTo(0, 6)
    expect(fieldCorner[1] - baseCorner[1]).toBeCloseTo(10, 6)

    // BoneChain layer: bend t2 by +25 deg AND apply local S-wave; indices reference must stay identical across frames
    const chainPose1 = model.pose(
      undefined,
      undefined,
      undefined,
      16,
      {},
      { t2: { rotation: 25 } },
      { tentacle: { grid: [3, 8], field: (_u, v) => [Math.sin(v * 4) * v * 6, 0] } },
    )
    const chainPose2 = model.pose(
      undefined,
      undefined,
      undefined,
      32,
      {},
      { t2: { rotation: 25 } },
      { tentacle: { grid: [3, 8], field: (_u, v) => [Math.sin(v * 4 + 0.5) * v * 6, 0] } },
    )
    const g1 = chainPose1.parts.find((p) => p.layerId === 'tentacle')!.geometry!
    const g2 = chainPose2.parts.find((p) => p.layerId === 'tentacle')!.geometry!
    // Reference identity guarantees PixiJS hits zero-reallocation fast path
    expect(g1.indices).toBe(g2.indices)
    expect(g1.uv).toBe(g2.uv)
    expect(g1.vertices).not.toEqual(g2.vertices)
  })

  it('preserves exact contour boundary vertices during plane-cut subdivision without sliver failures and enforces GeometryError', () => {
    // Build a curved crescent/bell silhouette alpha mask (120x100)
    const w = 120,
      h = 100
    const alpha = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x - 60) / 48
        const ny = (y - 54) / 40
        const outer = nx * nx + ny * ny <= 1
        const innerCut = nx * nx + ((y - 82) / 28) ** 2 < 0.72
        if (outer && !innerCut) alpha[y * w + x] = 255
      }
    }
    const contour = meshFromAlpha(alpha, w, h, { detail: 28, concavity: 22, refinement: 50, alphaThreshold: 8, padding: 2 })
    const rest = restMesh(contour, w, h)

    const subdivided = subdivideContourGrid(rest, w, h, 8, 8)
    expect(subdivided.indices.length).toBeGreaterThan(rest.indices.length)

    // Every original contour vertex must remain at its EXACT unmodified coordinates (0 px drift)
    for (let i = 0; i < rest.vertices.length; i += 2) {
      expect(subdivided.vertices[i]).toBe(rest.vertices[i])
      expect(subdivided.vertices[i + 1]).toBe(rest.vertices[i + 1])
    }

    // Plug contour mesh into a rig and run smooth wave deformation at both 8x8 and 16x16
    const manifest = sliceManifestSchema.parse({
      format: 'koma-rig.slices.v2',
      sourceId: 'contour-bell',
      blendSpace: 'srgb',
      canvas: { width: 200, height: 200 },
      reference: 'reference.png',
      layers: [{ layerId: 'bell', name: '伞帽', groups: [], texture: 'textures/0.png', rect: [40, 40, w, h], visible: true, opacity: 1 }],
    })
    const rig = editRig(manifest, emptyRig('contour-bell'), [
      { op: 'add-bone', boneId: 'root', name: '根', start: [100, 60], end: [100, 120] },
      { op: 'bind', layerId: 'bell', boneId: 'root' },
      { op: 'set-mesh', layerId: 'bell', mesh: contour },
    ])
    const model = createRig(manifest, rig)

    const posed = model.pose(undefined, undefined, undefined, 100, {}, {}, {
      bell: {
        grid: [12, 10],
        field: (u, v) => [(u - 0.5) * 8 * v, Math.sin(u * Math.PI * 2) * 4 * v],
      },
    })
    expect(posed.parts[0]!.geometry!.indices.length).toBeGreaterThan(rest.indices.length)

    // Extreme folding must still trigger GeometryError
    expect(() =>
      model.pose(undefined, undefined, undefined, 100, {}, {}, {
        bell: {
          grid: [6, 6],
          field: (u) => [(0.5 - u) * 260, 0],
        },
      }),
    ).toThrow(GeometryError)
  })

  it('cleanly falls back to undeformed state when deform is omitted on later frames', () => {
    const { manifest, rig } = makeMultiLayerFixture()
    const model = createRig(manifest, rig)

    const restPose = model.pose()
    const restRibbon = restPose.parts.find((p) => p.layerId === 'ribbon')!
    const restTentacle = restPose.parts.find((p) => p.layerId === 'tentacle')!
    expect(restRibbon.geometry).toBeUndefined()
    expect(restTentacle.geometry).toBeTruthy()

    const deformedPose = model.pose(undefined, undefined, undefined, 16, {}, {}, {
      ribbon: { grid: [4, 8], field: (_u, v) => [v * 8, 0] },
      tentacle: { grid: [4, 8], field: (_u, v) => [v * 6, 0] },
    })
    expect(deformedPose.parts.find((p) => p.layerId === 'ribbon')!.geometry).toBeTruthy()
    expect(deformedPose.parts.find((p) => p.layerId === 'tentacle')!.geometry!.indices).not.toBe(
      restTentacle.geometry!.indices,
    )

    // Next frame removes deform -> must restore cleanly with zero residue
    const afterPose = model.pose()
    const afterRibbon = afterPose.parts.find((p) => p.layerId === 'ribbon')!
    const afterTentacle = afterPose.parts.find((p) => p.layerId === 'tentacle')!
    expect(afterRibbon.geometry).toBeUndefined()
    expect(afterTentacle.geometry!.indices).toBe(restTentacle.geometry!.indices)
    expect(afterTentacle.geometry!.vertices).toEqual(restTentacle.geometry!.vertices)
  })

  it('validates unknown layerId, invalid grid bounds, and non-finite outputs, and stays fast at 16x16', () => {
    const { manifest, rig } = makeMultiLayerFixture()
    const model = createRig(manifest, rig)

    expect(() => model.pose(undefined, undefined, undefined, 0, {}, {}, { nope: () => [0, 0] })).toThrow(/未知变形图层/)
    expect(() =>
      model.pose(undefined, undefined, undefined, 0, {}, {}, { ribbon: { grid: [17, 4], field: () => [0, 0] } }),
    ).toThrow(/grid/)
    expect(() =>
      model.pose(undefined, undefined, undefined, 0, {}, {}, { ribbon: { grid: [0, 4], field: () => [0, 0] } }),
    ).toThrow(/grid/)
    expect(() => model.pose(undefined, undefined, undefined, 0, {}, {}, { ribbon: () => [Number.NaN, 0] })).toThrow(
      /非有限位移/,
    )

    // Performance check: 16x16 (512 triangles) over 30 warmed-up frames with Sweep-and-Prune checkGeometry
    const run16x16 = (phase: number, timeMs: number) =>
      model.pose(undefined, undefined, undefined, timeMs, {}, {}, {
        bell_front: {
          grid: [16, 16],
          field: (u, v) => [Math.sin(v * 5 + phase) * 5 * v, Math.cos(u * 4 + phase) * 3 * v],
        },
      })
    run16x16(0, 0)
    run16x16(0.1, 16)
    const t0 = performance.now()
    for (let f = 0; f < 30; f++) run16x16(f * 0.2, (f + 2) * 16)
    const elapsedMs = performance.now() - t0
    expect(elapsedMs).toBeLessThan(300)
  })
})
