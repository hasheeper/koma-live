import { expect, it } from 'vitest'
import type { Point } from '@koma-rig/rig-core'
import { meshPointerTarget, snapHandle } from '../apps/rig-studio/src/mesh-handles'

const points: Point[] = [[10,10], [60,60], [10,60]]
function input(cursor: Point, zoom = 1): Parameters<typeof meshPointerTarget>[0] {
  return {
    cursor, local:[cursor[0]/zoom,cursor[1]/zoom], points,
    screenPoints:points.map(([x,y])=>[x*zoom,y*zoom]),
    edges:[{a:0,b:1,uses:1},{a:1,b:2,uses:1},{a:2,b:0,uses:1}],
    size:[100,100], pixelsPerUnit:[zoom,zoom], touch:false, snap:true, insert:true, drawing:false, triangles:false,
  }
}
it('snaps to the actual slanted edge within three screen pixels at either zoom',()=>{
  for (const zoom of [1,4]) {
    const p=30*zoom
    const near=input([p+2,p-2],zoom)
    expect(meshPointerTarget(near)).toMatchObject({kind:'insert',a:0,b:1,onEdge:true,point:[30,30]})
    expect(meshPointerTarget({...near,snap:false})).toMatchObject({kind:'insert',onEdge:false,point:near.local})
    const far=input([p+3,p-3],zoom)
    expect(meshPointerTarget(far)).toMatchObject({kind:'insert',onEdge:false,point:far.local})
  }
})
it('keeps precise start closure separate from picking a vertex to move or delete',()=>{
  const near=input([12,10]), away=input([18,10])
  expect(meshPointerTarget({...near,drawing:true})).toMatchObject({kind:'vertex',index:0,closes:true})
  expect(meshPointerTarget({...away,drawing:true})).toMatchObject({kind:'plot'})
  expect(meshPointerTarget({...away,insert:false})).toMatchObject({kind:'vertex',index:0,closes:false})
})
it('uses the same short capture range for axis guides and releases beyond it',()=>{
  const peers:Point[]=[[12,40],[65,72]]
  const get=(p: Point, enabled=true)=>snapHandle(p,peers,undefined,[100,100],[4,4],enabled)
  expect(get([12.5,71.5])).toEqual({point:[12,72],guides:[{axis:0,value:12,peer:0},{axis:1,value:72,peer:1}]})
  expect(get([12.5,71.5],false).point).toEqual([12.5,71.5])
  expect(get([12.9,71]).guides).toEqual([])
})
