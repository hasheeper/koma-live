import { describe, expect, it } from 'vitest'
import {
  buildAutoHeadMorphs,
  createRig,
  diagnoseRig,
  editRig,
  emptyRig,
  exportRigSpec,
  syncSliceBinding,
} from '../src/index.js'

const baseManifest = {
  format: 'koma-rig.slices.v2' as const,
  blendSpace: 'srgb' as const,
  sourceId: 'sample-rig',
  canvas: { width: 1000, height: 1000 },
  reference: 'reference.png',
  layers: [
    {
      layerId: 'back_hair',
      name: 'Back Hair',
      groups: ['body'],
      texture: 'textures/0.png',
      sourceIndex: 0,
      rect: [300, 200, 400, 600] as [number, number, number, number],
      visible: true,
      opacity: 1,
    },
    {
      layerId: 'torso',
      name: 'Torso',
      groups: ['body'],
      texture: 'textures/1.png',
      sourceIndex: 1,
      rect: [400, 400, 200, 300] as [number, number, number, number],
      visible: true,
      opacity: 1,
    },
    {
      layerId: 'arm_r',
      name: 'Right Arm',
      groups: ['body'],
      texture: 'textures/2.png',
      sourceIndex: 2,
      rect: [580, 420, 120, 260] as [number, number, number, number],
      visible: true,
      opacity: 1,
    },
    {
      layerId: 'face',
      name: 'Face',
      groups: ['head'],
      texture: 'textures/3.png',
      sourceIndex: 3,
      rect: [400, 200, 200, 200] as [number, number, number, number],
      visible: true,
      opacity: 1,
    },
    {
      layerId: 'branch_r',
      name: 'Right Branch Hair',
      groups: ['body'],
      texture: 'textures/4.png',
      sourceIndex: 4,
      rect: [650, 480, 140, 240] as [number, number, number, number],
      visible: true,
      opacity: 1,
    },
  ],
}

function buildSampleRig() {
  return editRig(baseManifest, emptyRig('sample-rig'), [
    { op: 'add-bone', boneId: 'root', start: [500, 900], end: [500, 700] },
    { op: 'add-bone', boneId: 'chest', parentBoneId: 'root', end: [500, 450] },
    { op: 'add-bone', boneId: 'head', parentBoneId: 'chest', end: [500, 250] },
    // Intentionally distant off-root bone pivot for branch_r (300px away from [650, 480])
    { op: 'add-bone', boneId: 'branch_r_bone', parentBoneId: 'chest', start: [480, 720], end: [680, 720], snap: false },
    { op: 'bind', layerId: 'torso', boneId: 'chest' },
    { op: 'bind', layerId: 'face', boneId: 'head' },
    { op: 'bind', layerId: 'branch_r', boneId: 'branch_r_bone' },
    {
      op: 'set-mesh',
      layerId: 'torso',
      mesh: {
        points: [
          [0, 0],
          [200, 0],
          [200, 300],
          [0, 300],
        ],
        indices: [0, 1, 2, 0, 2, 3],
      },
    },
  ])
}

describe('rig doctor, slice sync, repivot, and headCalibration', () => {
  it('syncSliceBinding preserves 0.0000 px rest alignment after padding a slice upward', () => {
    const rig = buildSampleRig()
    const oldRect = baseManifest.layers[1]!.rect
    const newRect: [number, number, number, number] = [400, 350, 200, 350] // padded top +50px

    const paddedManifest = {
      ...baseManifest,
      layers: baseManifest.layers.map((l) => (l.layerId === 'torso' ? { ...l, rect: newRect } : l)),
    }

    // Case A: rect padded without syncing mesh/bindOrigin -> MUST catch mesh_origin_mismatch error!
    const unSyncedMeshDiag = diagnoseRig(paddedManifest, rig)
    expect(unSyncedMeshDiag.ok).toBe(false)
    expect(unSyncedMeshDiag.issues.some((i) => i.code === 'mesh_origin_mismatch' && i.layerId === 'torso')).toBe(true)

    // Case B: bindOrigin updated manually without compensating restOffset -> MUST catch 50px rest_drift error!
    const halfFixedRig = structuredClone(rig)
    halfFixedRig.bindings.find((b) => b.layerId === 'torso')!.bindOrigin = [400, 350]
    const brokenDriftDiag = diagnoseRig(paddedManifest, halfFixedRig)
    expect(brokenDriftDiag.ok).toBe(false)
    expect(brokenDriftDiag.issues.some((i) => i.code === 'rest_drift' && i.layerId === 'torso')).toBe(true)
    expect(brokenDriftDiag.summary.maxRestDriftPx).toBeCloseTo(50, 2)

    // After syncSliceBinding, both checks clear and rest drift drops to 0.000 px!
    const fixedRig = structuredClone(rig)
    const torsoBind = fixedRig.bindings.find((b) => b.layerId === 'torso')!
    const synced = syncSliceBinding(torsoBind, oldRect, newRect)
    expect(synced.bindOrigin).toEqual([400, 350])
    expect(synced.mesh!.points[0]).toEqual([0, 50])
    fixedRig.bindings = fixedRig.bindings.map((b) => (b.layerId === 'torso' ? synced : b))

    const okDiag = diagnoseRig(paddedManifest, fixedRig)
    expect(okDiag.ok).toBe(true)
    expect(okDiag.summary.maxRestDriftPx).toBeLessThan(0.001)
  })

  it('diagnoseRig catches off-root bone pivots and shadow draw-order conflicts; repivot-bone fixes pivot with 0 drift', () => {
    let rig = buildSampleRig()
    rig = editRig(baseManifest, rig, [
      {
        op: 'set-cast-shadows',
        castShadows: [{ casters: ['back_hair'], receivers: ['arm_r'], offset: [4, 6] }],
      },
    ])

    const before = diagnoseRig(baseManifest, rig)
    expect(before.issues.some((i) => i.code === 'pivot_far_from_layer' && i.boneId === 'branch_r_bone')).toBe(true)
    expect(before.issues.some((i) => i.code === 'shadow_order_conflict' && i.layerId === 'back_hair')).toBe(true)

    // Move branch_r_bone pivot right to the slice root (680, 480) via repivot-bone
    const repivoted = editRig(baseManifest, rig, [
      { op: 'repivot-bone', boneId: 'branch_r_bone', pivot: [680, 480], keepEnd: true },
    ])
    const after = diagnoseRig(baseManifest, repivoted)
    expect(after.summary.maxRestDriftPx).toBeLessThan(0.001)
    expect(after.issues.some((i) => i.code === 'pivot_far_from_layer' && i.boneId === 'branch_r_bone')).toBe(false)

    const model = createRig(baseManifest, repivoted)
    const restBone = model.skeleton.rest.get('branch_r_bone')!
    expect(restBone.start[0]).toBeCloseTo(680, 3)
    expect(restBone.start[1]).toBeCloseTo(480, 3)
    expect(restBone.end[0]).toBeCloseTo(680, 3)
    expect(restBone.end[1]).toBeCloseTo(720, 3)
  })

  it('auto-head calibration persists in rig.json and surfaces on exportRigSpec()', () => {
    const built = buildAutoHeadMorphs(baseManifest, {
      format: 'koma-rig.auto-head.v1',
      parameters: {
        yaw: { id: 'headYaw', deg: 21 },
        pitch: { id: 'headPitch', upDeg: 9.5, downDeg: 14.5 },
      },
      geometry: {
        faceLayer: 'face',
        pinNeck: true,
      },
      layers: {
        face: { role: 'face' },
      },
    })
    expect(built.calibration.yaw).toEqual({ id: 'headYaw', deg: 21 })
    expect(built.calibration.pitch).toEqual({ id: 'headPitch', upDeg: 9.5, downDeg: 14.5 })

    const rig = editRig(baseManifest, buildSampleRig(), [
      { op: 'set-parameter', parameter: { id: 'headYaw', meaning: 'yaw', unit: 'normalized', min: -1, max: 1, default: 0 } },
      { op: 'set-parameter', parameter: { id: 'headPitch', meaning: 'pitch', unit: 'normalized', min: -1, max: 1, default: 0 } },
      { op: 'set-morphs', morphs: built.morphs },
      { op: 'set-head-calibration', headCalibration: built.calibration },
    ])
    const spec = exportRigSpec(baseManifest, rig)
    expect(spec.headCalibration).toEqual(built.calibration)
  })
})
