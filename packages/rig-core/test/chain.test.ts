import {expect,it} from 'vitest'
import {attachmentPoint,createPlayer,createRig,editRig,emptyRig,exportCapabilities,previewRig,sliceManifestSchema,transform,validateMotion,matchesPublishedCapabilities} from '../src/index'
import source from '../../../tests/fixtures/chain-strip/manifest.json'
import setup from '../../../tests/fixtures/chain-strip/setup.json'
import old from '../../../tests/fixtures/paper/rig.json'
const manifest=sliceManifestSchema.parse(source)
const doc=editRig(manifest,emptyRig('chain-strip'),setup)
const rig=createRig(manifest,doc)
const clip=(angle:number)=>({format:'koma-rig.motion.v1',rigId:'chain-strip',rigVersion:1,durationMs:200,
  tracks:[{parameter:'bend',keys:[{timeMs:0,value:0},{timeMs:200,value:angle}]}],requests:[]})

it('skins the whole source layer, with an exact rest, two rigid ends and a blended joint',()=>{
  const rest=rig.pose().parts[0]!, end=createPlayer(rig,doc,clip(40)).advanceTo(200)
  const bent=end.parts[0]!, g=rest.geometry!
  expect(end.parameters.bend).toBe(40)
  expect(g.vertices.length).toBeGreaterThan(8)
  expect(g.uv).toEqual(bent.geometry!.uv)
  expect(g.indices).toEqual(bent.geometry!.indices)
  for(let i=0;i<g.vertices.length;i+=2) {
    const x=g.vertices[i]!, y=g.vertices[i+1]!
    expect(x).toBeCloseTo(g.uv[i]!*112,10)
    expect(y).toBeCloseTo(g.uv[i+1]!*16,10)
    const original=transform(rest.matrix,x,y), child=transform(end.bones![1]!.matrix,x-56,y-8)
    const w=Math.max(0,Math.min(1,(x-40)/32)), weight=w*w*(3-2*w)
    const final=transform(bent.matrix,bent.geometry!.vertices[i]!,bent.geometry!.vertices[i+1]!)
    for (const axis of [0,1] as const) expect(final[axis]).toBeCloseTo(original[axis]+weight*(child[axis]-original[axis]),9)
  }
  const combined=previewRig(rig,{rotations:{base:35,tip:40}})
  expect(combined.bones![1]!.matrix[0]).toBeCloseTo(Math.cos(75*Math.PI/180),10)
  expect(previewRig(rig, {parameters:{bend:40}}).parts).toEqual(end.parts)
})
it('treats advice as soft, reports the actual failing part and time and still rejects malformed drafts',()=>{
  const motion=clip(180)
  expect(validateMotion(doc,motion)).toEqual(motion)
  expect(()=>createPlayer(rig,doc,motion).advanceTo(200)).toThrow(/strip @ 200 ms.*三角形 [0-9]+.*翻面/)
  expect(()=>validateMotion(doc,clip(NaN))).toThrow()
  expect(()=>rig.pose({bend:0,extra:0})).toThrow('未知参数')
  for(const boneChain of [['tip','base'],['base','base'],['base','absent'],['base']])
    expect(()=>editRig(manifest,doc,[{op:'bind-chain',layerId:'strip',boneChain}])).toThrow()
  expect(()=>createRig(manifest,{...doc,bindings:[{...doc.bindings[0],boneId:'base'}]})).toThrow()
  const detached=editRig(manifest,doc,[{op:'unbind',layerId:'strip'}])
  expect(createRig(manifest,detached).pose().parts[0]!.matrix).toEqual(rig.pose().parts[0]!.matrix)
  const rebound=editRig(manifest,doc,[{op:'bind',boneId:'tip',layerId:'strip'}])
  expect(rebound.bindings[0]!.boneChain).toBeUndefined()
  expect(JSON.stringify(exportCapabilities(doc))).not.toMatch(/boneChain|jointSoftnessPx|ellipses/)
  const legacy={format:'koma-rig.capabilities.v1',rigId:old.rigId,rigVersion:old.rigVersion,...old.semantics}
  expect(matchesPublishedCapabilities(old,legacy)).toBe(true)
  expect(matchesPublishedCapabilities(old,{...legacy,ellipses:[]})).toBe(false)
})
it('combines local ribbon and secondary offsets with three explicitly related bones and retains an authored outline',()=>{
  const custom={points:[[4,2],[108,2],[108,14],[4,14]],indices:[0,1,2,0,2,3]}
  const rig3=editRig(manifest,doc,[
    {op:'add-bone',boneId:'third',parentBoneId:'tip',end:[150,64]},
    {op:'bind-chain',layerId:'strip',boneChain:['base','tip','third']},
    {op:'set-mesh',layerId:'strip',mesh:custom},
    {op:'set-parameter',parameter:{id:'wave',min:-1,max:1,default:0,meaning:'local bend',unit:'px'}},
    {op:'set-deformer',layerId:'strip',deformer:{kind:'ribbon',line:[[4,8,6],[108,8,6]],bend:1,minArea:1e-8,minRatio:0.001,parameter:'wave'}},
  ])
  const model=createRig(manifest,rig3)
  const rest=model.pose().parts[0]!.geometry!
  expect(Math.min(...rest.uv.filter((_,i)=>i%2===0))).toBeCloseTo(4/112)
  const first=model.pose({bend:30,wave:2}), withSecondary=model.pose({bend:30,wave:2},model.defaultSlots,{strip:3},10)
  expect(first.parts[0]!.geometry!.vertices).not.toEqual(withSecondary.parts[0]!.geometry!.vertices)
})

it('locates a self-intersection of distant faces after a five-bone chain curls back on itself',()=>{
  const narrow=structuredClone(manifest)
  narrow.layers[0]!.rect[3]=4
  const ids=['a','b','c','d','e']
  const bones=ids.map((id,i)=>({op:'add-bone',boneId:id,parentBoneId:ids[i-1],start:[16+22*i,58],end:[38+22*i,58]}))
  const model=createRig(narrow,editRig(narrow,emptyRig('strip'),[...bones,{op:'bind-chain',layerId:'strip',boneChain:ids,jointSoftnessPx:7}]))
  expect(()=>model.pose({}, {}, {},80,{b:90,c:90,d:90,e:90})).toThrow(/strip @ 80 ms.*三角形 [0-9]+ \/ [0-9]+ 自交/)
})
it('preserves rest pixels when recalibrating a chain and locates contacts on its final surface',()=>{
  const moved=editRig(manifest,doc,[{op:'place-bone',boneId:'base',start:[16,68],end:[72,72]}])
  const next=createRig(manifest,moved)
  expect(next.skeleton.rest.get('base')!.start).toEqual([16,68])
  const rest=next.pose().parts[0]!, before=rig.pose().parts[0]!
  for(const local of [[4,4],[100,14]] as const) {
    const a=attachmentPoint(rest,[112,16],[...local]),b=attachmentPoint(before,[112,16],[...local])
    a.forEach((x,i)=>expect(x).toBeCloseTo(b[i]!,9))
  }
  const pose=previewRig(rig,{rotations:{tip:40}})
  const p=attachmentPoint(pose.parts[0]!,[112,16],[104,8])
  const tip=transform(pose.bones![1]!.matrix,48,0)
  p.forEach((x,i)=>expect(x).toBeCloseTo(tip[i]!,9))
})
