import { expect, it } from 'vitest'
import {createRig, defaultTrace, editRig, emptyRig, exportCapabilities, meshEdges, meshFromAlpha, meshFromContour,
  previewRig, removeMeshVertex, restMesh, retessellateOutline, sliceManifestSchema, splitMeshEdge, suggestAlphaThreshold, type Point} from '../src/index'
import rawManifest from '../../../tests/fixtures/hinge/manifest.json'
import gridSetup from '../../../tests/fixtures/hinge/grid.json'

const outline:Point[]=[[0,0],[48,0],[48,12],[20,12],[20,32],[0,32]]
it('keeps the concave notch in either drawing direction and rejects self-intersection',()=>{
  for(const ring of [outline,[...outline].reverse()]) {
    const m=meshFromContour(ring)
    restMesh(m,48,32)
    const area=m.indices.reduce((sum,id,i,ids)=>{
      if(i%3) return sum
      const [a,b,c]=[id,ids[i+1]!,ids[i+2]!].map(k=>m.points[k]!) as [Point,Point,Point]
      return sum+((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2
    },0)
    expect(area).toBe(48*12+20*20)
  }
  expect(()=>meshFromContour([[0,0],[4,4],[4,0],[0,4]])).toThrow('自交')
})
it('traces the alpha cutoff and concavity with a small vertex budget and no interior handles',()=>{
  const w=60,h=40
  const alpha=Uint8Array.from({length:w*h},(_,i)=>{
    const x=i%w,y=Math.floor(i/w)
    if(x<2||y<2||x>=50||y>=34) return 0
    return x<22 || y<14 ? 180 : 3
  })
  const traced=meshFromAlpha(alpha,w,h)
  expect(traced.points.length).toBeLessThanOrEqual(10)
  expect(meshEdges(traced.indices).filter(e=>e.uses===1)).toHaveLength(traced.points.length)
  expect(traced.points).toContainEqual([22,14])
  const low=meshFromAlpha(alpha,w,h,{...defaultTrace,alphaThreshold:1})
  expect(low.points).not.toContainEqual([22,14])
  const hull=meshFromAlpha(alpha,w,h,{...defaultTrace,concavity:0})
  expect(hull.points).not.toContainEqual([22,14])
  expect(meshFromAlpha(alpha,w,h,{...defaultTrace,padding:2}).points).toContainEqual([0,0])
  expect(()=>meshFromAlpha(alpha,w,h,{...defaultTrace,alphaThreshold:200})).toThrow('阈值')
  expect(suggestAlphaThreshold(new Uint8Array([0,0,32,32,32]))).toBe(1)
})
it('keeps a traced mesh editable and serializes that topology through FFD evaluation',()=>{
  const manifest=sliceManifestSchema.parse(rawManifest)
  const original=meshFromContour(outline)
  const plus=splitMeshEdge(original,0,1,[24,0])
  const adjusted=retessellateOutline({...plus,points:plus.points.map((p,i)=>i===6?[22,1]:p)})
  const removed=removeMeshVertex(adjusted,6)
  expect(removed.points).toEqual(original.points)
  const doc=editRig(manifest,emptyRig('test'),[...gridSetup,{op:'set-mesh',layerId:'tip',mesh:adjusted}])
  const rig=createRig(manifest,JSON.parse(JSON.stringify(doc)))
  const part=rig.pose().parts.find(p=>p.layerId==='tip')!
  expect(part.geometry!.vertices).toEqual(adjusted.points.flat())
  expect(previewRig(rig,{parameters:{bend:1}}).parts.find(p=>p.layerId==='tip')!.geometry!.vertices).not.toEqual(part.geometry!.vertices)
  expect(JSON.stringify(exportCapabilities(doc))).not.toContain('"indices"')
})
