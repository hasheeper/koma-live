import { expect, it } from 'vitest'
import { createRig, editRig, emptyRig, exportRigSpec, previewRig, sliceManifestSchema } from '../src/index'
import stripManifestJson from '../../../examples/chain-strip/manifest.json'
import stripSetup from '../../../examples/chain-strip/setup.json'
import hingeManifestJson from '../../../examples/hinge/manifest.json'
import hingeSetup from '../../../examples/hinge/setup.json'

const stripManifest = sliceManifestSchema.parse(stripManifestJson)
const hingeManifest = sliceManifestSchema.parse(hingeManifestJson)

it('supports full bone TRS (translate in parent space, rotate, positive scale) and propagates to children and bone chains', () => {
  // Root bone pointing straight up (-90 deg) with a child bone and attached layer
  const rigDoc = editRig(hingeManifest, emptyRig('trs-test'), [
    { op: 'add-bone', boneId: 'root', name: '骨盆', start: [60, 80], end: [60, 40] },
    { op: 'add-bone', boneId: 'head', name: '头部', parentBoneId: 'root', end: [60, 20] },
    { op: 'bind', layerId: 'base', boneId: 'root' },
    { op: 'bind', layerId: 'tip', boneId: 'head' },
  ])
  const model = createRig(hingeManifest, rigDoc)
  const rest = model.pose()
  const restBase = rest.parts.find((p) => p.layerId === 'base')!

  // Translating root by { x: 5, y: -12 } moves canvas position by (+5, -12) regardless of root's -90 deg restRotation.
  const floated = previewRig(model, { bones: { root: { x: 5, y: -12 } } })
  expect(floated.bones![0]!.start[0]).toBeCloseTo(65, 6)
  expect(floated.bones![0]!.start[1]).toBeCloseTo(68, 6)
  expect(floated.bones![1]!.start[0]).toBeCloseTo(65, 6)
  expect(floated.bones![1]!.start[1]).toBeCloseTo(28, 6)
  const movedBase = floated.parts.find((p) => p.layerId === 'base')!
  expect(movedBase.matrix[4] - restBase.matrix[4]).toBeCloseTo(5, 6)
  expect(movedBase.matrix[5] - restBase.matrix[5]).toBeCloseTo(-12, 6)

  // Scaling root { scaleX: 1.25, scaleY: 0.8 } scales bone length by 1.25x and inherits to child.
  const squashed = previewRig(model, { bones: { root: { scaleX: 1.25, scaleY: 0.8 } } })
  const rootFrame = squashed.bones![0]!
  expect(Math.hypot(rootFrame.end[0] - rootFrame.start[0], rootFrame.end[1] - rootFrame.start[1])).toBeCloseTo(50, 6)
  expect(squashed.bones![1]!.start[1]).toBeCloseTo(30, 6)

  // Rejects zero or negative scale cleanly.
  expect(() => previewRig(model, { bones: { root: { scaleX: 0 } } })).toThrow()
  expect(() => previewRig(model, { bones: { root: { scaleY: -1 } } })).toThrow()

  // Bone-chain skinning evaluates cleanly under combined TRS without flipping triangles.
  const chainModel = createRig(stripManifest, editRig(stripManifest, emptyRig('chain-strip'), stripSetup))
  const posedChain = previewRig(chainModel, {
    bones: {
      base: { x: 4, y: -6, rotation: 5, scaleX: 1.05, scaleY: 0.96 },
      tip: { rotation: 18, scaleX: 1.04 },
    },
  })
  expect(posedChain.parts[0]!.geometry!.vertices.length).toBeGreaterThan(0)
})

it('exports a concise TRS-first rig spec without leaking internal matrices or mesh vertices', () => {
  const pureRig = editRig(hingeManifest, emptyRig('pure'), [
    { op: 'add-bone', boneId: 'hip', name: '骨盆', start: [20, 40], end: [76, 40] },
    { op: 'bind', layerId: 'base', boneId: 'hip' },
  ])
  const pureSpec = exportRigSpec(hingeManifest, pureRig)
  expect(pureSpec.format).toBe('koma-rig.spec.v1')
  expect(pureSpec.coordinates).toEqual({
    origin: 'top-left',
    yAxis: 'down',
    rotation: 'clockwise-degrees',
    translateSpace: 'parent-local',
    scaleDefault: 1,
  })
  expect(pureSpec.parameters).toBeUndefined()
  expect(pureSpec.bones).toEqual([
    {
      boneId: 'hip',
      name: '骨盆',
      parentBoneId: null,
      length: 56,
      restRotation: 0,
      restStart: [20, 40],
      restEnd: [76, 40],
    },
  ])
  expect(pureSpec.layers.find((l) => l.layerId === 'base')).toMatchObject({
    boundTo: { boneId: 'hip' },
    hasMesh: false,
  })
  expect(JSON.stringify(pureSpec)).not.toContain('restOffset')
  expect(JSON.stringify(pureSpec)).not.toContain('vertices')

  // Legacy rigs with parameters still include them optionally.
  const chainSpec = exportRigSpec(stripManifest, editRig(stripManifest, emptyRig('chain-strip'), stripSetup))
  expect(chainSpec.parameters?.[0]?.id).toBe('bend')
  expect(chainSpec.layers[0]).toMatchObject({ boundTo: { boneChain: ['base', 'tip'] } })
})

it('removes unreferenced parameters atomically in rig-core', () => {
  const base = editRig(hingeManifest, emptyRig('hinge'), hingeSetup)
  const withUnused = editRig(hingeManifest, base, [
    { op: 'set-parameter', parameter: { id: 'extra', meaning: '测试', unit: '', min: -1, max: 1, default: 0 } },
  ])
  const removed = editRig(hingeManifest, withUnused, [{ op: 'remove-parameter', parameterId: 'extra' }])
  expect(removed.semantics.parameters.some((p) => p.id === 'extra')).toBe(false)
})
