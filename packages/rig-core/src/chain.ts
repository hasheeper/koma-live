import type { Geometry, Point } from './geometry.js'
import { compose, inverse, transform, type BonePose, type Matrix, type Bone } from './skeleton.js'

type Station = { start: Point; axis: Point; length: number; at: number }
type Cut = { origin: Point; axis: Point }
type Influence = { left: number; right: number; weight: number }

export function quadGeometry(width: number, height: number): Geometry {
  return { vertices:[0,0,width,0,0,height,width,height], uv:[0,0,1,0,0,1,1,1], indices:[0,1,2,1,3,2] }
}

/** Clip convex source faces against rest-space joint sections before triangulating.
 * Adjacent faces reuse their intersection vertices and interpolated UVs. */
function subdivide(source: Geometry, restLayer: Matrix, cuts: Cut[]): Geometry {
  const vertices = source.vertices.slice(), uv = source.uv.slice()
  let faces: number[][] = []
  for (let i=0;i<source.indices.length;i+=3) faces.push(source.indices.slice(i,i+3))
  for (const {origin,axis} of cuts) {
    const distances: number[] = [], intersections = new Map<string,number>()
    for (let i=0;i<vertices.length;i+=2) {
      const [x,y]=transform(restLayer,vertices[i]!,vertices[i+1]!)
      const distance=(x-origin[0])*axis[0]+(y-origin[1])*axis[1]
      distances.push(Math.abs(distance)<1e-8 ? 0 : distance)
    }
    const next: number[][] = []
    for (const face of faces) {
      if (!face.some(i=>distances[i]!<0) || !face.some(i=>distances[i]!>0)) { next.push(face); continue }
      const left:number[]=[], right:number[]=[]
      for (let j=0;j<face.length;j++) {
        const a=face[j]!, b=face[(j+1)%face.length]!, da=distances[a]!, db=distances[b]!
        if (da<=0) left.push(a)
        if (da>=0) right.push(a)
        if (da*db>=0) continue
        const key=Math.min(a,b)+','+Math.max(a,b)
        let k=intersections.get(key)
        if (k===undefined) {
          k=vertices.length/2
          intersections.set(key,k)
          const t=da/(da-db)
          for (const array of [vertices,uv]) {
            for (const axis of [0,1]) array.push(array[2*a+axis]! + t*(array[2*b+axis]!-array[2*a+axis]!))
          }
        }
        left.push(k); right.push(k)
      }
      next.push(left,right)
    }
    faces=next
  }
  const indices:number[]=[]
  for (const face of faces) for (let j=1;j+1<face.length;j++) indices.push(face[0]!,face[j]!,face[j+1]!)
  return {vertices,uv,indices}
}

export function prepareChain(ids:string[], softness:number|undefined, bones:Map<string,Bone>,
  restFrames:Map<string,BonePose>, restLayer:Matrix, source:Geometry) {
  if (ids.length<2 || new Set(ids).size!==ids.length) throw new Error('骨链需要至少两根不同的骨骼')
  const stations: Station[] = []
  let at=0
  for (const [i,id] of ids.entries()) {
    const bone=bones.get(id), frame=restFrames.get(id)
    if (!bone || !frame || (i && bone.parentBoneId!==ids[i-1])) throw new Error('骨链必须按直接父子顺序连接 · '+id)
    const end=i+1<ids.length ? restFrames.get(ids[i+1]!)?.start : frame.end
    if (!end) throw new Error('未知骨链成员 '+ids[i+1])
    const dx=end[0]-frame.start[0], dy=end[1]-frame.start[1], length=Math.hypot(dx,dy)
    if (length<1e-7) throw new Error('骨链投影段长度为零 · '+id)
    stations.push({start:frame.start,axis:[dx/length,dy/length],length,at})
    at+=length
  }
  const defaultWidth=stations.reduce((w,s)=>Math.min(w,s.length/4),Infinity)
  const cuts: Cut[]=[]
  const widths=stations.slice(1).map((joint,j)=>{
    const before=stations[j]!
    const shorter=Math.min(before.length,joint.length)
    const width=Math.min(softness ?? defaultWidth,shorter/2)
    for (const step of [-1,-0.5,0,0.5,1]) {
      const axis=step<0?before.axis:joint.axis
      cuts.push({axis,origin:[joint.start[0]+step*width*axis[0],joint.start[1]+step*width*axis[1]]})
    }
    return width
  })
  const geometry=subdivide(source,restLayer,cuts)
  function influence(x:number,y:number):Influence {
    const p=transform(restLayer,x,y)
    let best=Infinity, s=0, segment=0
    for (const [i,{start,axis,length,at}] of stations.entries()) {
      const dx=p[0]-start[0],dy=p[1]-start[1]
      const t=Math.max(0,Math.min(length,dx*axis[0]+dy*axis[1]))
      const d=(dx-t*axis[0])**2+(dy-t*axis[1])**2
      if (d<best) { best=d; s=at+t; segment=i }
    }
    for (let j=0;j<widths.length;j++) {
      const width=widths[j]!, offset=s-stations[j+1]!.at
      if (Math.abs(offset)>width) continue
      const t=(offset/width+1)/2
      return {left:j,right:j+1,weight:t*t*(3-2*t)}
    }
    return {left:segment,right:segment,weight:0}
  }
  const weights: Influence[]=[]
  for (let i=0;i<geometry.vertices.length;i+=2) weights.push(influence(geometry.vertices[i]!,geometry.vertices[i+1]!))
  const inverseBinds=ids.map(id=>compose(inverse(restFrames.get(id)!.matrix),restLayer))
  function posed(frames:Map<string,BonePose>) {
    const matrices=ids.map((id,i)=>compose(frames.get(id)!.matrix,inverseBinds[i]!))
    // The part matrix applies root motion once. Skin the vertices in its local frame.
    const toLocal=inverse(matrices[0]!)
    const deltas=matrices.map(m=>compose(toLocal,m))
    function blend(x:number,y:number,{left,right,weight}:Influence):Point {
      const a=transform(deltas[left]!,x,y), b=transform(deltas[right]!,x,y)
      return [a[0]+weight*(b[0]-a[0]),a[1]+weight*(b[1]-a[1])]
    }
    return {
      point(rest:Point,local:Point) {return blend(...local,influence(...rest))},
      geometry(local:Geometry):Geometry {
        const vertices=weights.flatMap((w,i)=>blend(local.vertices[2*i]!,local.vertices[2*i+1]!,w))
        return {...local,vertices}
      },
    }
  }
  function skinFor(custom: Geometry) {
    const customWeights: Influence[] = []
    for (let i = 0; i < custom.vertices.length; i += 2) {
      customWeights.push(influence(custom.vertices[i]!, custom.vertices[i + 1]!))
    }
    return (frames: Map<string, BonePose>, local: Geometry): Geometry => {
      const matrices = ids.map((id, i) => compose(frames.get(id)!.matrix, inverseBinds[i]!))
      const toLocal = inverse(matrices[0]!)
      const deltas = matrices.map((m) => compose(toLocal, m))
      const vertices = new Array<number>(local.vertices.length)
      for (let i = 0; i < customWeights.length; i++) {
        const { left, right, weight } = customWeights[i]!
        const lx = local.vertices[2 * i]!,
          ly = local.vertices[2 * i + 1]!
        const a = transform(deltas[left]!, lx, ly),
          b = transform(deltas[right]!, lx, ly)
        vertices[2 * i] = a[0] + weight * (b[0] - a[0])
        vertices[2 * i + 1] = a[1] + weight * (b[1] - a[1])
      }
      return { vertices, uv: local.uv, indices: local.indices }
    }
  }
  return { geometry, posed, skinFor }
}
