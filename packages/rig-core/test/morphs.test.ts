import { expect, it } from 'vitest'
import { attachmentPoint, createRig, editRig, emptyRig, exportRigSpec, GeometryError, sliceManifestSchema } from '../src/index'
import manifestData from '../../../tests/fixtures/chain-strip/manifest.json'
import chainSetup from '../../../tests/fixtures/chain-strip/setup.json'

const manifest = sliceManifestSchema.parse(manifestData)
const blank = emptyRig('chain-strip')
const axis = (id: string) => ({ parameter: id, samples: [-1, 0, 1] })
const parameter = (id: string) => ({ op: 'set-parameter', parameter: { id, meaning: id, unit: '', min: -1, max: 1, default: 0 } })
const shape = (dx: number, dy: number) => [0,0,dx,0,0,dy,dx,dy]
const morph = { layerId: 'strip', grid: [1,1], axes: [axis('yaw')], deltas: [shape(-4,2), null, shape(8,4)] }
const pitch = { ...morph, axes: [axis('pitch')], deltas: [shape(0,-2), null, shape(0,6)] }
const document = (grids: unknown[], base: unknown = blank) => editRig(manifest, base, [
  parameter('yaw'), parameter('pitch'), { op: 'set-morphs', morphs: grids },
])
const size: [number,number] = [112,16]

it('saves and clears morphs atomically, exports axes, clamps parameters and adds independent grids in rest pixels', () => {
  const doc = document([morph,pitch])
  const rig = createRig(manifest, JSON.parse(JSON.stringify(doc)))
  expect(exportRigSpec(manifest, doc).parameters?.map(p => p.id)).toEqual(['yaw','pitch'])
  expect(rig.pose().parts).toEqual(createRig(manifest,blank).pose().parts)
  expect(rig.pose({yaw:.5,pitch:2}).parts[0]!.geometry!.vertices).toEqual([0,0,116,0,0,24,116,24])
  expect(rig.pose({yaw:-4,pitch:0}).parts[0]!.geometry!.vertices).toEqual([0,0,108,0,0,18,108,18])
  expect(rig.pose().parts[0]!.geometry).toBeUndefined()
  expect(editRig(manifest, doc, [{op:'set-morphs',morphs:[]}]).morphs).toBeUndefined()
  expect(() => editRig(manifest, doc, [{op:'remove-parameter',parameterId:'yaw'}])).toThrow(/yaw/)
  expect(doc.morphs).toHaveLength(2)
})

it('interpolates nonuniform axes in row-major order, preserves null weights and samples off-grid UVs', () => {
  const grid = { ...morph, axes: [{parameter:'yaw',samples:[-1,0,2]},axis('pitch')],
    deltas: [null,null,null,null,null,shape(12,0),null,shape(0,4),shape(20,8)] }
  const rig = createRig(manifest,document([grid]))
  const part = rig.pose({yaw:1,pitch:.5},undefined,{},0,{}, {},{strip:{grid:[4,4],field:() => [3,-1]}}).parts[0]!
  // Four equally weighted samples give (+8u, +3v) plus the independent script.
  expect(attachmentPoint(part,size,[28,8])).toEqual([16+28+2+3,56+8+1.5-1])
})

it('keeps fine Morph knots over a coarse script and preserves script precedence over FFD', () => {
  const fine = {...morph, grid:[2,1], deltas:[null,null,[0,0,0,3,0,0,0,0,0,3,0,0]]}
  const ffd = {kind:'ffd',parameter:'pitch',size:3,offsets:Array(9).fill([0,2]),minArea:1e-8,minRatio:.01}
  const doc = editRig(manifest,document([fine]),[{op:'set-deformer',layerId:'strip',deformer:ffd}])
  const rig = createRig(manifest,doc)
  const pose = (field?: () => [number,number]) => rig.pose({yaw:1,pitch:1},undefined,{},0,{}, {},
    field ? {strip:{grid:[1,1],field}} : undefined).parts[0]!
  expect(attachmentPoint(pose(),size,[56,8])[1]).toBeCloseTo(56+8+2+3,9)
  expect(attachmentPoint(pose(() => [0,1]),size,[56,8])[1]).toBeCloseTo(56+8+1+3,9)
})

it('preserves the underlying bent silhouette through zero and rotates Morph offsets once at the chain tip', () => {
  const fine = {...morph,grid:[5,3],deltas:[null,null,Array.from({length:24},()=>[2,0]).flat()]}
  const base = editRig(manifest,blank,chainSetup)
  const rig = createRig(manifest,document([fine],base))
  const frame = (yaw: number) => rig.pose({yaw,pitch:0,bend:24}).parts[0]!
  const zero = frame(0), near = frame(1e-8), full = frame(1)
  for (const x of [17,43,51,58,66,91]) {
    const initial = attachmentPoint(zero,size,[x,5]), current = attachmentPoint(near,size,[x,5])
    expect(current[0]).toBeCloseTo(initial[0],6)
    expect(current[1]).toBeCloseTo(initial[1],6)
  }
  expect(near.geometry!.indices).toBe(full.geometry!.indices)
  const a=attachmentPoint(zero,size,[112,8]), b=attachmentPoint(full,size,[112,8])
  expect(b[0]-a[0]).toBeCloseTo(2*Math.cos(24*Math.PI/180),8)
  expect(b[1]-a[1]).toBeCloseTo(2*Math.sin(24*Math.PI/180),8)
})

it('validates axes, references, data dimensions, finite values and posed triangle area', () => {
  for (const change of [
    {layerId:'missing'}, {axes:[axis('missing')]}, {axes:[axis('yaw'),axis('yaw')]},
    {axes:[{parameter:'yaw',samples:[0,0,1]}]}, {grid:[17,1]}, {deltas:[]},
    {deltas:[null,null,[1,2]]}, {deltas:[null,null,shape(Infinity,0)]},
  ]) expect(() => document([{...morph,...change}])).toThrow()
  const bad = createRig(manifest,document([{...morph,deltas:[null,null,shape(-180,0)]}]))
  expect(() => bad.pose({yaw:1,pitch:0})).toThrow(GeometryError)
  expect(() => bad.pose({yaw:1,pitch:0},undefined,{},0,{}, {},undefined,{validateGeometry:false})).not.toThrow()
})

it('retains a posed ribbon when adding a finer Morph surface', () => {
  const ribbon = {kind:'ribbon',parameter:'pitch',line:[[0,8,5],[48,8,5],[112,8,5]],
    bend:2,minArea:1e-8,minRatio:.01}
  const base = editRig(manifest,document([]),[{op:'set-deformer',layerId:'strip',deformer:ribbon}])
  const original = createRig(manifest,base).pose({yaw:0,pitch:1}).parts[0]!
  const fine = {...morph,grid:[5,3],deltas:[null,null,Array.from({length:24},()=>[1,2]).flat()]}
  const posed = createRig(manifest,document([fine],base)).pose({yaw:1,pitch:1}).parts[0]!
  for (const x of [9,31,72,107]) {
    const [ax,ay] = attachmentPoint(original,size,[x,8]), [bx,by] = attachmentPoint(posed,size,[x,8])
    expect(bx-ax).toBeCloseTo(1,9)
    expect(by-ay).toBeCloseTo(2,9)
  }
})
