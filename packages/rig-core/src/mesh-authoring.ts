import type { AttachmentMesh, Point } from './geometry.js'

const cross = (a: Point, b: Point, c: Point) =>
  (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
const between = (a: number, b: number, value: number) => value >= Math.min(a,b) && value <= Math.max(a,b)
function onSegment(a: Point, b: Point, p: Point) {
  return cross(a,b,p) === 0 && between(a[0],b[0],p[0]) && between(a[1],b[1],p[1])
}
function intersects(a: Point, b: Point, c: Point, d: Point) {
  return cross(a,b,c)*cross(a,b,d) < 0 && cross(c,d,a)*cross(c,d,b) < 0 ||
    onSegment(a,b,c) || onSegment(a,b,d) || onSegment(c,d,a) || onSegment(c,d,b)
}

/** Triangulate a simple, possibly concave contour, in either drawing direction. */
export function meshFromContour(points: Point[]): AttachmentMesh {
  const count = points.length
  if (count < 3) throw new Error('沿轮廓至少放置三个点')
  if (new Set(points.map(p => p.join(','))).size !== count) throw new Error('轮廓点重合')
  let area = 0
  for (let i = 0; i < count; i++) {
    const next = (i+1)%count, a = points[i]!, b = points[next]!
    area += a[0]*b[1] - b[0]*a[1]
    for (let j = i+2; j < count; j++) {
      const end = (j+1)%count
      if (end !== i && intersects(a,b,points[j]!,points[end]!)) throw new Error('轮廓边自交，请调整交叉处的点')
    }
  }
  if (Math.abs(area) < 1e-8) throw new Error('轮廓没有面积')
  const ring = Array.from({length: count}, (_, i) => i)
  if (area < 0) ring.reverse()
  const indices: number[] = []
  while (ring.length > 3) {
    const ear = ring.findIndex((id,j) => {
      const before = ring[(j+ring.length-1)%ring.length]!, after = ring[(j+1)%ring.length]!
      const a = points[before]!, b = points[id]!, c = points[after]!
      if (cross(a,b,c) <= 1e-8) return false
      return !ring.some(k => k !== before && k !== id && k !== after &&
        cross(a,b,points[k]!) >= 0 && cross(b,c,points[k]!) >= 0 && cross(c,a,points[k]!) >= 0)
    })
    if (ear < 0) throw new Error('无法三角化轮廓，请检查折返点')
    indices.push(ring[(ear+ring.length-1)%ring.length]!, ring[ear]!, ring[(ear+1)%ring.length]!)
    ring.splice(ear,1)
  }
  indices.push(...ring)
  return {points, indices}
}

function convexHull(points: Point[]): Point[] {
  const sorted = points.sort((a,b) => a[0]-b[0] || a[1]-b[1])
  function half(order: Point[]) {
    const chain: Point[] = []
    for (const p of order) {
      while (chain.length >= 2 && cross(chain[chain.length-2]!,chain[chain.length-1]!,p) <= 0) chain.pop()
      chain.push(p)
    }
    chain.pop()
    return chain
  }
  return [...half(sorted), ...half(sorted.reverse())]
}

export interface TraceOptions {
  detail: number
  concavity: number
  refinement: number
  alphaThreshold: number
  padding: number
}
export const defaultTrace: TraceOptions = {detail:20, concavity:50, refinement:50, alphaThreshold:8, padding:0}

/** Scale the default cutoff for faint artwork using its nontransparent opacity distribution. */
export function suggestAlphaThreshold(alpha: Uint8Array) {
  const histogram = new Uint32Array(256)
  let count = 0
  for (const value of alpha) if (value) { histogram[value]!++; count++ }
  if (!count) return 1
  let sum = 0
  for (let i = 1; i < 256; i++) {
    sum += histogram[i]!
    if (sum >= count * .9) return Math.max(1, Math.round(i/32))
  }
  return 8
}

function signedArea(ring: Point[]) {
  return ring.reduce((sum, a, i) => {
    const b = ring[(i+1)%ring.length]!
    return sum + a[0]*b[1]-a[1]*b[0]
  },0)
}

function traceRings(alpha: Uint8Array, w: number, h: number, options: TraceOptions) {
  const {alphaThreshold, padding, refinement} = options
  const step = Math.max(1, Math.ceil(Math.max(w,h)/(96 + refinement*5)))
  const cols = Math.ceil(w/step), rows = Math.ceil(h/step), stride = cols+1
  // Prefix sums let every trace cell inspect exactly its requested padding in source pixels.
  const sums = new Uint32Array((w+1)*(h+1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      if (alpha[y*w+x]! >= Math.max(1,alphaThreshold)) row++
      sums[(y+1)*(w+1)+x+1] = sums[y*(w+1)+x+1]! + row
    }
  }
  const filled = new Uint8Array(cols*rows)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const l = Math.max(0,x*step-padding), r = Math.min(w,(x+1)*step+padding)
    const t = Math.max(0,y*step-padding)*(w+1), b = Math.min(h,(y+1)*step+padding)*(w+1)
    filled[y*cols+x] = Number(sums[b+r]! - sums[t+r]! - sums[b+l]! + sums[t+l]! > 0)
  }
  // Clockwise exterior edges in image coordinates. At a diagonal contact,
  // take the right turn to keep four-connected silhouettes separate.
  const edges = new Map<number, number>()
  const add = (vertex:number, dir:number) => edges.set(vertex,(edges.get(vertex) ?? 0) | (1<<dir))
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y*cols+x, v = y*stride+x
    if (!filled[i]) continue
    if (!y || !filled[i-cols]) add(v,0)
    if (x===cols-1 || !filled[i+1]) add(v+1,1)
    if (y===rows-1 || !filled[i+cols]) add(v+stride+1,2)
    if (!x || !filled[i-1]) add(v+stride,3)
  }
  const rings: Point[][] = [], moves = [1,stride,-1,-stride]
  while (edges.size) {
    const start: number = edges.keys().next().value!
    let at = start, last = -1
    const ring: Point[] = []
    do {
      const bits = edges.get(at)!
      const dir = [1,0,3,2].map(turn => (last+turn+4)%4).find(d => bits & (1<<d))!
      if (dir !== last) ring.push([Math.min(w,(at%stride)*step),Math.min(h,Math.floor(at/stride)*step)])
      const remaining = bits & ~(1<<dir)
      if (remaining) edges.set(at,remaining); else edges.delete(at)
      at += moves[dir]!
      last = dir
    } while (at !== start)
    // Holes keep their alpha in the texture without extra editing handles.
    if (signedArea(ring)>0) rings.push(ring)
  }
  return rings
}

function insideContour(p:Point, ring:Point[]) {
  let inside = false
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i+1)%ring.length]!
    if (Math.abs(cross(a,b,p))<1e-6 && p[0]>=Math.min(a[0],b[0])-1e-6 && p[0]<=Math.max(a[0],b[0])+1e-6 && p[1]>=Math.min(a[1],b[1])-1e-6 && p[1]<=Math.max(a[1],b[1])+1e-6) return true
    if ((a[1]>p[1]) !== (b[1]>p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside = !inside
  }
  return inside
}

function enclosingPolygon(ring:Point[], budget:number): Point[] {
  const hull = convexHull(ring.slice())
  if (hull.length <= budget) return hull
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity
  for (const [x,y] of hull) { minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y) }
  let poly: Point[] = [[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]]
  // Start from the bounding rectangle. Each supporting edge cuts off the
  // largest empty corner without cutting through the source silhouette.
  const supports = hull.map((a,i) => [a,hull[(i+1)%hull.length]!] as const)
  while (poly.length < budget && supports.length) {
    let bestArea = signedArea(poly), best = -1, result = poly
    supports.forEach(([a,b],j) => {
      const next: Point[] = []
      for (let i=0; i<poly.length; i++) {
        const p=poly[i]!, q=poly[(i+1)%poly.length]!, dp=cross(a,b,p), dq=cross(a,b,q)
        if (dp >= -1e-8) next.push(p)
        if ((dp < -1e-8 && dq > 1e-8) || (dp > 1e-8 && dq < -1e-8)) {
          const t = dp/(dp-dq)
          next.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])])
        }
      }
      const area=signedArea(next)
      if (area < bestArea-1e-6) { bestArea=area;best=j;result=next }
    })
    if (best < 0) break
    supports.splice(best,1)
    poly=result
  }
  return poly
}

function simplifyOutline(ring:Point[], options:TraceOptions, width:number, height:number) {
  const budget = 4 + Math.round(options.detail*.30)
  const enclosure = enclosingPolygon(ring,budget)
  if (options.concavity === 0) return enclosure
  if (ring.length <= budget) return ring
  // Add the strongest bend on the surviving arcs. Concavity specifically
  // weights inward turns, while detail budgets the total number of handles.
  let far = 1
  const distance = (a:Point,b:Point) => Math.hypot(b[0]-a[0],b[1]-a[1])
  for (let i=2;i<ring.length;i++) if (distance(ring[0]!,ring[i]!)>distance(ring[0]!,ring[far]!)) far=i
  const keep = [0,far], n = ring.length
  while (keep.length < budget) {
    let chosen=-1, insert=-1, score=.25+(100-options.refinement)*.025
    for (let j=0;j<keep.length;j++) {
      const start=keep[j]!, end=keep[(j+1)%keep.length]!, a=ring[start]!, b=ring[end]!, length=distance(a,b)
      if (!length) continue
      for (let i=(start+1)%n;i!==end;i=(i+1)%n) {
        const deviation=cross(a,b,ring[i]!)/length
        const weight=deviation>0 ? options.concavity/50 : 1
        if (Math.abs(deviation)*weight>score) {score=Math.abs(deviation)*weight;chosen=i;insert=j+1}
      }
    }
    if (chosen<0) break
    keep.splice(insert,0,chosen)
  }
  if (keep.length < 3) return enclosure
  // Shift each simplified chord outward to cover all pixels along its arc.
  const lines = keep.map((start,j) => {
    const end=keep[(j+1)%keep.length]!, a=ring[start]!, b=ring[end]!, len=distance(a,b)
    const x=(b[1]-a[1])/len, y=(a[0]-b[0])/len
    let limit=x*a[0]+y*a[1]
    for (let i=(start+1)%n;i!==end;i=(i+1)%n) limit=Math.max(limit,x*ring[i]![0]+y*ring[i]![1])
    return {x,y,limit}
  })
  const points: Point[] = []
  for (let i=0;i<lines.length;i++) {
    const a=lines[(i+lines.length-1)%lines.length]!, b=lines[i]!, det=a.x*b.y-a.y*b.x
    if (Math.abs(det)<1e-8) return enclosure
    points.push([Math.min(width,Math.max(0,(a.limit*b.y-a.y*b.limit)/det)),Math.min(height,Math.max(0,(a.x*b.limit-a.limit*b.x)/det))])
  }
  if (signedArea(points)<=0 || !ring.every(p=>insideContour(p,points))) return enclosure
  try { meshFromContour(points) } catch { return enclosure }
  return points
}

export function meshFromAlpha(alpha:Uint8Array, width:number, height:number, options:TraceOptions = defaultTrace): AttachmentMesh {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || alpha.length!==width*height)
    throw new Error('透明通道与切片尺寸不符')
  for (const [value,max] of [[options.detail,100],[options.concavity,100],[options.refinement,100],[options.alphaThreshold,255],[options.padding,32]] as const)
    if (!Number.isInteger(value) || value<0 || value>max) throw new Error('描绘参数超出范围')
  const rings=traceRings(alpha,width,height,options)
  if (!rings.length) throw new Error('当前阈值下没有可见像素，请降低 Alpha 阈值')
  if (rings.length > Math.max(3, Math.floor((4+options.detail*.30)/3))) {
    return meshFromContour(enclosingPolygon(rings.flat(),4+Math.round(options.detail*.30)))
  }
  const outlines=rings.map(r=>simplifyOutline(r,options,width,height))
  const result:AttachmentMesh={points:[],indices:[]}
  // Distant islands keep separate outlines. An enclosing island already
  // carries the alpha of any smaller islands inside its transparent holes.
  const accepted:Point[][]=[]
  for(const outline of outlines.sort((a,b)=>signedArea(b)-signedArea(a))) {
    if(accepted.some(poly=>outline.every(p=>insideContour(p,poly)))) continue
    if(accepted.some(poly=>outline.some((a,i)=>poly.some((c,j)=>intersects(a,outline[(i+1)%outline.length]!,c,poly[(j+1)%poly.length]!))))) {
      return meshFromContour(enclosingPolygon(rings.flat(),4+Math.round(options.detail*.30)))
    }
    const part=meshFromContour(outline), offset=result.points.length
    result.indices.push(...part.indices.map(i=>i+offset))
    result.points.push(...part.points)
    accepted.push(outline)
  }
  return result
}

/** Boundary edges have one incident face, internal edges have two. */
export function meshEdges(indices:number[]) {
  const edges = new Map<string,{a:number;b:number;uses:number}>()
  for (let i=0;i<indices.length;i+=3) for (let j=0;j<3;j++) {
    const a=indices[i+j]!, b=indices[i+(j+1)%3]!, key=Math.min(a,b)+','+Math.max(a,b)
    const edge=edges.get(key)
    if (edge) edge.uses++
    else edges.set(key,{a,b,uses:1})
  }
  return [...edges.values()]
}

export function splitMeshEdge(mesh:AttachmentMesh, a:number, b:number, point:Point):AttachmentMesh {
  const indices:number[]=[], id=mesh.points.length
  let found=false
  for (let i=0;i<mesh.indices.length;i+=3) {
    const face=mesh.indices.slice(i,i+3)
    const side=face.findIndex((v,j)=>v===a && face[(j+1)%3]===b || v===b && face[(j+1)%3]===a)
    if (side<0) { indices.push(...face); continue }
    found=true
    const start=face[side]!, end=face[(side+1)%3]!, third=face[(side+2)%3]!
    indices.push(start,id,third,id,end,third)
  }
  if (!found) throw new Error('请选择网格边')
  return {points:[...mesh.points,point],indices}
}

/** Fill only the removed vertex's incident fan; other islands and handles keep their positions. */
export function removeMeshVertex(mesh:AttachmentMesh, id:number):AttachmentMesh {
  const edges=new Map<number,number>(), ends=new Set<number>(), indices:number[]=[]
  for (let i=0;i<mesh.indices.length;i+=3) {
    const tri=mesh.indices.slice(i,i+3), j=tri.indexOf(id)
    if (j<0) {indices.push(...tri);continue}
    const a=tri[(j+1)%3]!, b=tri[(j+2)%3]!
    edges.set(a,b); ends.add(b)
  }
  if (!edges.size) throw new Error('未知顶点')
  const first=[...edges.keys()].find(k=>!ends.has(k)) ?? edges.keys().next().value!
  const neighbors=[first]
  let last=first
  while(edges.has(last)) {
    const next=edges.get(last)!
    edges.delete(last)
    if (next===first) break
    neighbors.push(next);last=next
  }
  if (edges.size) throw new Error('顶点连接多个独立轮廓')
  if(neighbors.length>=3) {
    const fill=meshFromContour(neighbors.map(i=>mesh.points[i]!))
    indices.push(...fill.indices.map(i=>neighbors[i]!))
  }
  const points=mesh.points.filter((_,i)=>i!==id)
  if (new Set(indices).size!==points.length || points.length<3) throw new Error('每个轮廓至少需要三个顶点')
  return {points,indices:indices.map(i=>i>id ? i-1 : i)}
}

/** A concave bend can invalidate a former diagonal. Rebuild it from the
 * boundary, preserving vertex IDs. Meshes with inner vertices keep their authored faces. */
export function retessellateOutline(mesh:AttachmentMesh):AttachmentMesh {
  const edges=meshEdges(mesh.indices).filter(e=>e.uses===1)
  const next=new Map(edges.map(e=>[e.a,e.b]))
  if (next.size!==mesh.points.length || edges.length!==next.size) return mesh
  const indices:number[]=[]
  while(next.size) {
    const start=next.keys().next().value!, ring=[start]
    let id=start
    do {
      const to=next.get(id)
      if(to===undefined) return mesh
      next.delete(id)
      id=to
      if(id!==start) ring.push(id)
    } while (id!==start)
    const points=ring.map(i=>mesh.points[i]!)
    if (signedArea(points)<=0) return mesh
    indices.push(...meshFromContour(points).indices.map(i=>ring[i]!))
  }
  return {...mesh,indices}
}
