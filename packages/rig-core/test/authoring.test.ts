import { expect, it } from 'vitest'
import {
  createPlayer,
  createRig,
  editRig,
  emptyRig,
  exportCapabilities,
  previewRig,
  sliceManifestSchema,
  transform,
} from '../src/index'
import manifestJson from '../../../tests/fixtures/paper/manifest.json'
import paper from '../../../tests/fixtures/paper/rig.json'
import tilt from '../../../tests/fixtures/paper/motions/tilt.json'

const manifest = sliceManifestSchema.parse(manifestJson)
const empty = emptyRig('paper')
const commands = [
  { op: 'add-bone', boneId: 'a', start: [100, 80], end: [100, 105] },
  { op: 'add-bone', boneId: 'b', parentBoneId: 'a', end: [110, 105] },
  { op: 'add-bone', boneId: 'pin', start: [100, 105], end: [100, 105] },
  { op: 'bind', boneId: 'a', layerId: 'psd-2' },
  { op: 'bind', boneId: 'b', layerId: 'psd-4' },
]
const doc = editRig(manifest, empty, commands)
const model = createRig(manifest, doc)
function near(a: number[], b: number[]) {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 10))
}

it('persists parent-local drags, explicitly selected tips, independent coincident roots and zero-length joints', () => {
  expect(doc.bones[0]).toMatchObject({ rotation: 90, length: 25 })
  expect(doc.bones[1]).toMatchObject({ parentBoneId: 'a', x: 25, y: 0, rotation: -90, length: 10 })
  expect(doc.bones[2]).toMatchObject({ length: 0 })
  const changed = editRig(manifest, doc, [
    { op: 'edit-bone', boneId: 'a', changes: { length: 50 } },
    { op: 'add-bone', boneId: 'offset', parentBoneId: 'a', snap: false, start: [102, 87], end: [102, 87] },
  ])
  const frames = createRig(manifest, changed).skeleton.rest
  near(frames.get('b')!.start, [100, 105])
  near(frames.get('a')!.end, [100, 130])
  near(frames.get('offset')!.end, [102, 87])
  near(previewRig(model, { rotations: { a: 10 } }).bones![2]!.start, [100, 105])
})

it('rotates across the shared joint, isolates a child rotation and recovers rest after reopening', () => {
  const pose = previewRig(model, { rotations: { a: 7, b: 3 } })
  near(pose.bones![0]!.end, pose.bones![1]!.start)
  near(
    transform(pose.parts[1]!.matrix, 100 - 55, 105 - 36),
    transform(pose.parts[3]!.matrix, 100 - 121, 105 - 76),
  )
  const childOnly = previewRig(model, { rotations: { b: 10 } })
  near(childOnly.parts[1]!.matrix, model.restLayerMatrix('psd-2'))
  expect(childOnly.parts[3]!.matrix).not.toEqual(model.restLayerMatrix('psd-4'))
  const reopened = createRig(manifest, JSON.parse(JSON.stringify(doc)))
  expect(previewRig(reopened)).toEqual(model.pose())
  expect(previewRig(reopened, { rotations: { a: 7, b: 3 } })).toEqual(pose)
})

it('preserves all six image transform components across binding, rebinding, unbinding and padding changes', () => {
  const moved = editRig(manifest, doc, [
    { op: 'edit-bone', boneId: 'a', changes: { x: 93, y: 43, rotation: 114 } },
  ])
  const initial = createRig(manifest, moved).pose().parts[3]!.matrix
  expect(initial[1]).not.toBe(0)
  const bound = editRig(manifest, moved, [{ op: 'bind', layerId: 'psd-4', boneId: 'pin' }])
  const detached = editRig(manifest, bound, [{ op: 'unbind', layerId: 'psd-4' }])
  for (const raw of [bound, detached]) near(createRig(manifest, raw).pose().parts[3]!.matrix, initial)
  const next = createRig(manifest, detached)
  near(previewRig(next, { rotations: { pin: 15, b: -15 } }).parts[3]!.matrix, initial)
  expect(next.skeleton.byId.has('pin')).toBe(true)
  const padded = structuredClone(manifest)
  padded.layers[3]!.rect[0] -= 6
  near(transform(createRig(padded, bound).pose().parts[3]!.matrix, 6, 0), transform(initial, 0, 0))
  const order = manifest.layers.map((l) => l.layerId).reverse()
  const multi = editRig(manifest, bound, [
    { op: 'bind', boneId: 'pin', layerId: 'psd-2' },
    { op: 'draw-order', layers: order },
  ])
  expect(
    createRig(manifest, multi)
      .pose()
      .parts.map((l) => l.layerId),
  ).toEqual(order)
  expect(multi.bindings.filter((b) => b.boneId === 'pin')).toHaveLength(2)
})

it('validates edits atomically, preserves a reparented rest and allows only semantic motion tracks', () => {
  const snapshot = JSON.stringify(doc)
  for (const edit of [
    { op: 'reparent', boneId: 'a', parentBoneId: 'b' },
    { op: 'remove-bone', boneId: 'b' },
    { op: 'bind', layerId: 'psd-4', boneId: 'absent' },
    { ...commands[0] },
    { op: 'edit-bone', boneId: 'a', changes: { length: -1 } },
  ])
    expect(() => editRig(manifest, doc, [edit])).toThrow()
  expect(JSON.stringify(doc)).toBe(snapshot)
  const reparented = editRig(manifest, doc, [{ op: 'reparent', boneId: 'b', parentBoneId: 'pin' }])
  near(createRig(manifest, reparented).skeleton.rest.get('b')!.matrix, model.skeleton.rest.get('b')!.matrix)
  const rig = editRig(manifest, empty, [
    ...commands,
    { op: 'set-parameter', parameter: paper.semantics.parameters[0] },
    { op: 'edit-bone', boneId: 'a', changes: { drives: [{ parameter: 'tiltX', degrees: 1 }] } },
  ])
  const runtime = createRig(manifest, rig)
  const frame = createPlayer(runtime, rig, tilt).advanceTo(400)
  near(frame.bones![0]!.matrix, previewRig(runtime, { rotations: { a: 4 } }).bones![0]!.matrix)
  expect(exportCapabilities(rig)).not.toHaveProperty('bones')
  expect(() => createPlayer(runtime, rig, { ...tilt, rotations: { a: 7 } })).toThrow()
})

it('authors a locked FFD and a root-locked ribbon, with geometry identical in the preview and evaluator', () => {
  const param = { id: 'flex', meaning: '弯曲', unit: '', min: -1, max: 1, default: 0 }
  const rig = editRig(manifest, empty, [
    { op: 'set-parameter', parameter: param },
    {
      op: 'create-ffd',
      layerId: 'psd-2',
      size: 3,
      parameter: 'flex',
      locked: [0, 3, 6],
      maxDisplacementPx: 6,
      minArea: 0.001,
      minRatio: 0.1,
    },
    { op: 'ffd-point', layerId: 'psd-2', index: 5, offset: [0, 4] },
    {
      op: 'set-deformer',
      layerId: 'psd-4',
      deformer: {
        kind: 'ribbon',
        parameter: 'flex',
        line: [
          [4, 0, 3],
          [4, 9, 3],
        ],
        bend: 1,
        maxBend: 2,
        minArea: 0.001,
        minRatio: 0.1,
      },
    },
  ])
  const model = createRig(manifest, rig)
  const rest = model.pose().parts,
    flex = previewRig(model, { parameters: { flex: 1 } }).parts
  expect(flex[1]!.geometry!.indices).toHaveLength(96)
  expect(flex[1]!.geometry!.vertices).not.toEqual(rest[1]!.geometry!.vertices)
  expect(flex[3]!.geometry!.vertices.slice(0, 4)).toEqual(rest[3]!.geometry!.vertices.slice(0, 4))
  expect(() =>
    editRig(manifest, rig, [{ op: 'ffd-point', layerId: 'psd-2', index: 0, offset: [5, 0] }]),
  ).toThrow('锁定')
})

it('keeps author locks distinct from visibility and inherited motion', () => {
  const settings = { op: 'set-layer', layerId: 'psd-2', locked: true, visible: false }
  const edited = editRig(manifest, doc, [settings])
  const pose = previewRig(createRig(manifest, edited), { rotations: { a: 5 } })
  expect(pose.parts[1]!.visible).toBe(false)
  expect(pose.parts[3]!.visible).toBe(true)
  expect(pose.parts[1]!.matrix).not.toEqual(model.restLayerMatrix('psd-2'))
  expect(() => editRig(manifest, edited, [{ op: 'unbind', layerId: 'psd-2' }])).toThrow('锁定')
  expect(
    editRig(manifest, edited, [
      { ...settings, locked: false },
      { op: 'unbind', layerId: 'psd-2' },
    ]).bindings[0]!.boneId,
  ).toBeUndefined()
})

it('supports translucent peekOpacity / peekAfter layer settings and rejects unknown anchors', () => {
  const edited = editRig(manifest, doc, [
    { op: 'set-layer', layerId: 'psd-2', peekOpacity: 0.55, peekAfter: 'psd-4' },
  ])
  const pose = createRig(manifest, edited).pose()
  const p2 = pose.parts.find((p) => p.layerId === 'psd-2')!
  expect(p2.peekOpacity).toBe(0.55)
  expect(p2.peekAfter).toBe('psd-4')
  const cleared = editRig(manifest, edited, [{ op: 'set-layer', layerId: 'psd-2', peekOpacity: 0 }])
  expect(createRig(manifest, cleared).pose().parts.find((p) => p.layerId === 'psd-2')!.peekOpacity).toBeUndefined()
  expect(() =>
    editRig(manifest, doc, [{ op: 'set-layer', layerId: 'psd-2', peekOpacity: 0.5, peekAfter: 'missing' }]),
  ).toThrow('未知透发锚点图层')
})
