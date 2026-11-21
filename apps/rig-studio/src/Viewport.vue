<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { hitPart } from './picking'
import { meshPointerTarget, projectToEdge, pointOnEdge, snapHandle, snapRadius, type SnapGuide } from './mesh-handles'
import { drawPlacement } from './mesh-preview'
import { paintWorkspaceGrid } from './workspace-grid'
import { meshEdges, inverse, transform, type Point, type Pose } from '@koma-rig/rig-core'
import { mountCharacter } from '@koma-rig/rig-renderer'
import type { Mode, Project, MeshDraft, Selection, Tool } from './project'

const props = defineProps<{ project: Project; pose: Pose; selected: Selection; driver?: string; highlightBones?:string[]; softnessPreview?:number; focusedBone?:string; focusName?:string; eligible?:Set<string>; pickingBones:boolean; inspectingBones:boolean; meshDraft: MeshDraft | null; tracing:boolean; triangles:boolean; activeVertex:number|null; snapping:boolean; vertexTool:'move'|'insert'|'delete'; tool: Tool; mode: Mode; bones: boolean; rotations: Record<string,number>; theme: string; issuePolygons?: Point[][] }>()
const emit = defineEmits<{
  hoverBone:[id?:string]; place:[id:string,start:Point,end:Point]; beginVertex: [index:number]; endVertex:[cancelled:boolean]; insertPoint:[a:number,b:number,point:Point]; deletePoint:[id:number]; plot: [point: Point, index?:number]; closeContour: []; select: [item: Selection]; rotate: [value:number]; create: [start:Point,end:Point,parent?:string,snap?:boolean]; zoom: [percent:number]; error: [message:string]
}>()
const stage = ref<HTMLElement>(), surface=ref<HTMLElement>(), overlay=ref<HTMLCanvasElement>()
const cameraFrame = ref<HTMLElement>()
const documentCorners = ref<HTMLElement>()
const workspaceGrid = ref<HTMLCanvasElement>()
let paintedGrid = ''
let renderer: Awaited<ReturnType<typeof mountCharacter>> | undefined
let observer: ResizeObserver | undefined, disposed=false, frame=0
let scale=1, zoom=1, pan:Point=[0,0], origin:Point=[0,0], space=false
type Gesture={kind:'place';id:string;from:Point;start:Point;end:Point;tip:boolean;moved:boolean}|{kind:'vertex'; index:number; at:Point; offset:Point; moved:boolean; closes:boolean; onEdge:boolean}|{kind:'delete';index:number}|{kind:'pan'; at:Point; initial:Point}|{kind:'create';start:Point;end:Point;parent?:string;parentEnd?:Point;snap:boolean}|{kind:'rotate';pivot:Point;angle:number;initial:number}
let drag:Gesture|null=null
interface MeshCursor { at: Point; alt: boolean; touch: boolean }
let meshCursor:MeshCursor|null=null, guides:SnapGuide[]=[]
const highlighted = computed(() => new Set(props.highlightBones))
const draftEdges = computed(() => meshEdges(props.meshDraft?.indices ?? []))
function adjacentOutline(index: number) {
  const draft = props.meshDraft!
  return draft.drawing ? [index-1, index+1].filter(i => draft.points[i])
    : draftEdges.value.filter(e => e.uses===1 && (e.a===index || e.b===index)).map(e => e.a===index ? e.b : e.a)
}
let previousCamera: {zoom:number; pan:Point} | null = null
const meshPart = () => props.pose.parts.find(p => p.layerId === props.meshDraft?.layerId)
const view=()=>stage.value!.getBoundingClientRect()
function framing() {
  const area = cameraFrame.value!.getBoundingClientRect(), viewport = view()
  const left = area.left - viewport.left, top = area.top - viewport.top
  const {width, height} = props.project.manifest.canvas
  const fitScale = .88 * Math.min(Math.max(1,area.width)/width, Math.max(1,area.height)/height)
  return {left, top, width:area.width, height:area.height, cx:left+area.width/2, cy:top+area.height/2, fitScale}
}
const toScreen=(p:Point):Point=>[p[0]*scale+origin[0],p[1]*scale+origin[1]]
const cursor=(e:PointerEvent|WheelEvent):Point=>[e.clientX-view().left,e.clientY-view().top]
const world=(p:Point):Point=>[(p[0]-origin[0])/scale,(p[1]-origin[1])/scale]
function meshLines(ctx:CanvasRenderingContext2D, points:Point[], edges:ReturnType<typeof meshEdges>, all:boolean, moving?:number, ink?:string) {
  if (all) {
    ctx.save()
    if (ink) ctx.strokeStyle = ink
    ctx.globalAlpha *= 0.28
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const {a,b,uses} of edges) if(uses > 1) {
      ctx.moveTo(...points[a]!); ctx.lineTo(...points[b]!)
    }
    ctx.stroke()
    ctx.restore()
  }
  ctx.save()
  if (ink) ctx.strokeStyle = ink
  ctx.beginPath()
  for (const {a,b,uses} of edges) if(uses===1 && !(a===moving || b===moving)) {
    ctx.moveTo(...points[a]!); ctx.lineTo(...points[b]!)
  }
  ctx.stroke()
  ctx.restore()
}
function strokeHandle(ctx:CanvasRenderingContext2D, path:Path2D, underlay:string, ink:string, width:number, rimExtra=1.6) {
  ctx.strokeStyle=underlay; ctx.lineWidth=width+rimExtra; ctx.stroke(path)
  ctx.strokeStyle=ink; ctx.lineWidth=width; ctx.stroke(path)
}
function paint(){
  const el=overlay.value,host=surface.value
  if(!el||!host)return
  const {width:w,height:h}=view(), {width:mw,height:mh}=props.project.manifest.canvas
  if(!w||!h)return
  const d=window.devicePixelRatio||1
  const room = framing()
  scale=zoom*room.fitScale
  origin=[room.cx-mw*scale/2+pan[0],room.cy-mh*scale/2+pan[1]]
  host.style.transform='matrix('+[scale,0,0,scale,...origin].join(',')+')'
  const gridKey = [w,h,d,scale,...origin,props.theme].join('/')
  if (workspaceGrid.value && paintedGrid!==gridKey) {
    paintWorkspaceGrid(workspaceGrid.value,w,h,d,scale,origin)
    paintedGrid=gridKey
  }
  if (documentCorners.value) {
    documentCorners.value.style.width=mw*scale+'px'
    documentCorners.value.style.height=mh*scale+'px'
    documentCorners.value.style.transform='translate('+origin[0]+'px,'+origin[1]+'px)'
  }
  emit('zoom',Math.round(scale*100))
  if(el.width!==Math.round(w*d)||el.height!==Math.round(h*d)){el.width=Math.round(w*d);el.height=Math.round(h*d)}
  const ctx=el.getContext('2d');if(!ctx)return
  ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h)
  const css=getComputedStyle(el)
  const jointInk=css.getPropertyValue('--rig-joint').trim(), boneInk=css.getPropertyValue('--rig-bone').trim()
  const selectedInk=css.getPropertyValue('--rig-selected').trim()
  const guideInk=css.getPropertyValue('--fg-secondary').trim(), textInk=css.getPropertyValue('--fg-primary').trim()
  const rim=css.getPropertyValue('--sunken').trim()
  function circle(x:number,y:number,r:number,fill:string,stroke:string){
    if(!ctx)return
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=stroke;ctx.lineWidth=1.2;ctx.stroke()
  }
  if (props.meshDraft) {
    const draft = props.meshDraft, part = meshPart()
    if (!part) return
    const points = draft.points.map(pt => toScreen(transform(part.matrix, ...pt)))
    const moving = drag?.kind === 'vertex' && drag.moved ? drag.index : undefined
    ctx.strokeStyle = selectedInk
    ctx.lineWidth = 1.25
    ctx.beginPath()
    if (draft.drawing) {
      points.forEach((pt,i) => { if (i && i!==moving && i-1!==moving) ctx.lineTo(...pt); else ctx.moveTo(...pt) })
      ctx.stroke()
    } else {
      meshLines(ctx, points, draftEdges.value, props.triangles, moving, selectedInk)
    }
    const layer = props.project.manifest.layers.find(l=>l.layerId===draft.layerId)!
    const [, ,width,height]=layer.rect
    const screen=(p:Point)=>toScreen(transform(part.matrix,...p))
    const target = meshCursor && (!drag || drag.kind==='delete') && !space && !props.tracing ? pointerTarget(meshCursor, points) : undefined
    const hoverVertex = target?.kind === 'vertex' ? target.index : null
    const closing = target?.kind === 'vertex' && target.closes
    const activeGuides = target && target.kind !== 'vertex' ? target.guides : guides
    for (const {axis,value,peer} of activeGuides) {
      const from=screen(axis===0?[value,0]:[0,value]), to=screen(axis===0?[value,height]:[width,value])
      const dx=to[0]-from[0],dy=to[1]-from[1],len=Math.hypot(dx,dy)||1
      ctx.save();ctx.strokeStyle=guideInk;ctx.globalAlpha=.95;ctx.setLineDash([5,4]);ctx.lineWidth=1.2
      ctx.beginPath();ctx.moveTo(from[0]-dx/len*22,from[1]-dy/len*22);ctx.lineTo(to[0]+dx/len*22,to[1]+dy/len*22);ctx.stroke();ctx.restore()
      if (peer!==undefined && points[peer]) { const [px,py]=points[peer]!;ctx.strokeStyle=jointInk;ctx.strokeRect(px-6,py-6,12,12) }
    }
    const active=props.activeVertex
    const deleting = props.vertexTool==='delete' && (drag?.kind!=='delete' || drag.index===hoverVertex)
      ? hoverVertex : null
    function handle(i:number) {
      const [x,y]=points[i]!, selected=i===active, hot=i===hoverVertex
      const radius=selected?6.5:hot?6:4.5
      if(!ctx)return
      if(i===deleting) {
        const danger=css.getPropertyValue('--mesh-delete').trim()
        const radius=drag?.kind==='delete'?7:8.5
        circle(x,y,radius+3,rim,danger)
        circle(x,y,radius,danger,rim)
        ctx.beginPath(); ctx.moveTo(x-4,y); ctx.lineTo(x+4,y)
        ctx.strokeStyle=css.getPropertyValue('--mesh-delete-ink').trim(); ctx.lineWidth=2; ctx.stroke()
        return
      }
      if(selected || hot) { ctx.beginPath();ctx.arc(x,y,radius+3.5,0,Math.PI*2);ctx.strokeStyle=jointInk;ctx.lineWidth=1.5;ctx.stroke() }
      ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fillStyle=selected||hot?jointInk:rim;ctx.fill()
      ctx.lineWidth=2;ctx.strokeStyle=selected||hot?rim:guideInk;ctx.stroke()
      if(selected) {ctx.beginPath();ctx.arc(x,y,1.8,0,Math.PI*2);ctx.fillStyle=rim;ctx.fill()}
    }
    points.forEach((_,i)=>{if(i!==active && i!==hoverVertex)handle(i)})
    if(hoverVertex!==null && hoverVertex!==active && points[hoverVertex])handle(hoverVertex)
    if(active!==null && points[active])handle(active)
    const colors = {ink:guideInk, rim, candidate:css.getPropertyValue('--mesh-candidate').trim()}
    if (moving !== undefined && points[moving]) {
      const neighbors = adjacentOutline(moving)
      drawPlacement(ctx, neighbors.map(i=>points[i]!), points[moving]!, false, colors, !!guides.length || (drag?.kind==='vertex' && drag.onEdge))
    } else if (target?.kind === 'plot' || target?.kind === 'insert' || closing) {
      const anchors = target.kind === 'insert' ? [points[target.a]!, points[target.b]!] : points
      const end = target.kind === 'vertex' ? points[target.index]! : screen(target.point)
      drawPlacement(ctx, anchors, end, closing, colors, closing || !!activeGuides.length || (target.kind==='insert' && target.onEdge))
    }
    const label = draft.drawing || props.vertexTool === 'insert' ? null
      : drag?.kind === 'vertex' ? drag.index : hoverVertex ?? active
    if(label!==null && points[label]) {
      const [x,y]=points[label]!, pt=draft.points[label]!
      const value='#'+(label+1)+'   '+Number(pt[0].toFixed(1))+', '+Number(pt[1].toFixed(1))
      ctx.font='12px "JetBrains Mono Variable",monospace'
      const width=ctx.measureText(value).width+12
      const left=Math.max(4,Math.min(w-width-4,x+13)), top=Math.max(4,Math.min(h-24,y-27))
      ctx.beginPath();ctx.roundRect(left,top,width,21,5);ctx.fillStyle=rim;ctx.fill()
      ctx.fillStyle=textInk;ctx.fillText(value,left+6,top+14)
    }
    return
  }
  if (props.selected && (props.selected.type === 'layer' || props.selected.type === 'attachment')) {
    const id = props.selected.id
    const part = props.pose.parts.find(p => p.layerId === id)
    const layer = props.project.manifest.layers.find(l => l.layerId === id)
    if (layer && part?.visible) {
      const screen = (x: number, y: number) => toScreen(transform(part.matrix, x, y))
      ctx.save()
      ctx.strokeStyle = selectedInk
      ctx.lineWidth = 1.2
      if (part.geometry) {
        const { vertices, indices } = part.geometry
        const points:Point[] = []
        for (let i=0;i<vertices.length;i+=2) points.push(screen(vertices[i]!, vertices[i+1]!))
        ctx.globalAlpha = .88
        meshLines(ctx, points, meshEdges(indices), true, undefined, selectedInk)
      } else {
        const [, ,width,height] = layer.rect
        const corners: Point[] = [[0,0], [width,0], [width,height], [0,height]]
        // A selected image without mesh reads as a solid white frame with a dark underlay, like Spine's region bounds.
        const frame = new Path2D()
        corners.forEach(([x,y],i) => { const pt = screen(x,y); if (i) frame.lineTo(...pt); else frame.moveTo(...pt) })
        frame.closePath()
        ctx.lineJoin = 'miter'
        strokeHandle(ctx, frame, rim, textInk, 1.25)
      }
      ctx.restore()
    }
  }
  if (props.softnessPreview!==undefined && props.highlightBones) {
    const byId = new Map(props.pose.bones?.map(b => [b.boneId,b]))
    const chain = props.highlightBones.map(id => byId.get(id))
    ctx.save();ctx.strokeStyle=jointInk;ctx.fillStyle=guideInk
    for (let i=1;i<chain.length;i++) {
      const prev=chain[i-1], joint=chain[i]
      if (!prev || !joint) continue
      const tip=chain[i+1]?.start ?? joint.end
      const lengthA=Math.hypot(prev.start[0]-joint.start[0],prev.start[1]-joint.start[1])
      const lengthB=Math.hypot(tip[0]-joint.start[0],tip[1]-joint.start[1])
      const range=Math.min(props.softnessPreview,lengthA/2,lengthB/2)
      if (!range) continue
      const [x,y]=toScreen(joint.start)
      for (const [point,len] of [[prev.start,lengthA],[tip,lengthB]] as const) {
        const dx=(point[0]-joint.start[0])/len, dy=(point[1]-joint.start[1])/len
        ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(dy,dx))
        ctx.globalAlpha=.14;ctx.fillRect(0,-8,range*scale,16)
        ctx.globalAlpha=.9;ctx.beginPath();ctx.moveTo(range*scale,-8);ctx.lineTo(range*scale,8);ctx.stroke()
        ctx.restore()
      }
    }
    ctx.restore()
  }
  if (props.issuePolygons?.length) {
    const danger = css.getPropertyValue('--mesh-delete').trim() || css.getPropertyValue('--warn').trim()
    ctx.save()
    ctx.lineJoin = 'round'
    for (const poly of props.issuePolygons) {
      if (poly.length < 3) continue
      const path = new Path2D()
      poly.forEach((pt, i) => {
        const s = toScreen(pt)
        if (i) path.lineTo(...s)
        else path.moveTo(...s)
      })
      path.closePath()
      ctx.globalAlpha = 0.28
      ctx.fillStyle = danger
      ctx.fill(path)
      ctx.globalAlpha = 0.95
      strokeHandle(ctx, path, rim, danger, 1.5, 1.4)
    }
    ctx.restore()
  }
  if(props.bones){
    // Only a selected or picked bone gets the full cyan selection; a hovered bone gets a crisp hover state, and the bone driving a selected image is related.
    const selectedBoneId=props.selected?.type==='bone'?props.selected.id:undefined
    const focusedId=props.focusedBone
    const related=selectedBoneId===undefined && focusedId===undefined ? props.driver : undefined
    // Damped zoom factor: slightly shrinks bones when zoomed out, slightly enlarges when zoomed in.
    const boneUiScale=Math.min(1.42,Math.max(0.68,Math.pow(zoom,0.34)))
    const radius=2.7*boneUiScale, rimExtra=1.3*boneUiScale
    const rank=(id:string)=>id===selectedBoneId?3:id===focusedId?2:id===related||highlighted.value.has(id)?1:0
    for(const b of [...(props.pose.bones??[])].sort((a,b)=>rank(a.boneId)-rank(b.boneId))){
      const shown=drag?.kind==='place' && drag.id===b.boneId ? drag : b
      const [x,y]=toScreen(shown.start),[ex,ey]=toScreen(shown.end),len=Math.hypot(ex-x,ey-y)
      const isSelected=b.boneId===selectedBoneId || (props.pickingBones && highlighted.value.has(b.boneId))
      const focused=b.boneId===focusedId
      const active=isSelected || focused
      const linked=!active && (b.boneId===related || highlighted.value.has(b.boneId))
      ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(ey-y,ex-x))
      ctx.globalAlpha=props.eligible && !props.eligible.has(b.boneId) ? .24 : active ? 1 : linked ? .88 : .72
      ctx.lineJoin='round'; ctx.lineCap='round'
      const ink=isSelected?selectedInk:focused?boneInk:linked?boneInk:guideInk
      const body=new Path2D(), nodes=new Path2D()
      const showTip=(isSelected || focused) && props.mode==='setup' && !props.pickingBones && len>2*radius+4*boneUiScale
      if(len>radius+3*boneUiScale) {
        const tipX=showTip ? len-radius*0.75 : len
        const run=Math.max(0,tipX-radius)
        const shoulder=radius+Math.min(run*.18, 9*boneUiScale)
        const half=Math.min(run*.085, (isSelected?3.2:focused?2.8:2.3)*boneUiScale)
        body.moveTo(radius,0); body.lineTo(shoulder,-half); body.lineTo(tipX,0); body.lineTo(shoulder,half); body.closePath()
        // Selected bones get a solid cyan body; hovered bones get a soft highlight fill.
        if(isSelected){ ctx.save(); ctx.globalAlpha*=.68; ctx.fillStyle=selectedInk; ctx.fill(body); ctx.restore() }
        else if(focused){ ctx.save(); ctx.globalAlpha*=.45; ctx.fillStyle=selectedInk; ctx.fill(body); ctx.restore() }
        else { ctx.save(); ctx.globalAlpha*=.55; ctx.fillStyle=css.getPropertyValue('--hover').trim(); ctx.fill(body); ctx.restore() }
        if(showTip) {
          const tipR=radius*0.75
          nodes.moveTo(len+tipR,0); nodes.arc(len,0,tipR,0,Math.PI*2)
        }
      } else if(len===0) {
        const tick=2.6*boneUiScale
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          body.moveTo(dx*radius,dy*radius); body.lineTo(dx*(radius+tick),dy*(radius+tick))
        }
      }
      strokeHandle(ctx,body,rim,ink,(isSelected?1.6:focused?1.45:1.05)*boneUiScale,rimExtra)
      nodes.moveTo(radius,0); nodes.arc(0,0,radius,0,Math.PI*2)
      strokeHandle(ctx,nodes,rim,isSelected?selectedInk:focused||linked?boneInk:guideInk,(isSelected?1.55:focused?1.4:1.15)*boneUiScale,rimExtra)
      if (focused || (isSelected && props.mode==='pose')) {
        const ring=new Path2D()
        const ringRadius=isSelected && props.mode==='pose' ? 14*boneUiScale : radius+2.8*boneUiScale
        ring.arc(0,0,ringRadius,0,Math.PI*2)
        strokeHandle(ctx,ring,rim,selectedInk,1.2*boneUiScale,rimExtra)
      }
      ctx.restore()
      if (focused) {
        const midX=(x+ex)/2, midY=(y+ey)/2
        if (midX<0 || midX>w || midY<0 || midY>h) continue
        const label = props.focusName ?? b.boneId
        ctx.save()
        ctx.font='12px '+css.getPropertyValue('--sans').trim()
        const text = label.length>30 ? label.slice(0,18)+'…'+label.slice(-10) : label
        const width=Math.min(w-8,ctx.measureText(text).width+16)
        const left=Math.min(w-width-4,Math.max(4,midX-width/2)), top=Math.max(3,midY-31)
        ctx.fillStyle=css.getPropertyValue('--panel').trim()
        ctx.strokeStyle=css.getPropertyValue('--panel-border').trim();ctx.lineWidth=1
        ctx.beginPath();ctx.roundRect(left,top,width,21,5);ctx.fill();ctx.stroke()
        ctx.fillStyle=textInk;ctx.fillText(text,left+8,top+14,width-16)
        ctx.restore()
      }
    }
  }
  if(drag?.kind==='create'){
    const [sx,sy]=toScreen(drag.start), [ex,ey]=toScreen(drag.end)
    ctx.save()
    if (!drag.snap && drag.parentEnd) {
      ctx.beginPath();ctx.moveTo(...toScreen(drag.parentEnd));ctx.lineTo(sx,sy)
      ctx.strokeStyle=guideInk;ctx.globalAlpha=.55;ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.stroke()
    }
    ctx.globalAlpha=1;ctx.strokeStyle=selectedInk;ctx.lineWidth=1.8;ctx.setLineDash([4,3])
    ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath();ctx.arc(sx,sy,3,0,Math.PI*2);ctx.stroke()
    ctx.restore()
  }
}
function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;paint()})}
function refreshGrid() { paintedGrid=''; schedule() }
function fit(){pan=[0,0];zoom=1;paint()}
function magnify(factor:number,at?:Point){
  const room=framing(),p=at??[room.cx,room.cy],anchor=world(p)
  zoom=Math.min(props.meshDraft?512:12,Math.max(.15,zoom*factor));paint()
  const next=toScreen(anchor);pan=[pan[0]+p[0]-next[0],pan[1]+p[1]-next[1]];paint()
}
function revealBone(id: string) {
  const bone = props.pose.bones?.find(b => b.boneId === id)
  if (!bone || !stage.value) return
  const room = framing()
  const [x,y] = toScreen([(bone.start[0] + bone.end[0]) / 2, (bone.start[1] + bone.end[1]) / 2])
  if (x >= room.left+14 && x <= room.left+room.width-14 && y >= room.top+14 && y <= room.top+room.height-14) return
  pan = [pan[0] + room.cx - x, pan[1] + room.cy - y]
  schedule()
}
defineExpose({fit,magnify,focusMesh,revealBone})
function hitBone(p:Point):string | undefined {
  const boneUiScale=Math.min(1.42,Math.max(0.68,Math.pow(zoom,0.34)))
  let distance=8*boneUiScale,closest:string|undefined
  const active=props.pose.bones?.find(b=>props.selected?.type==='bone'&&b.boneId===props.selected.id)
  if(props.bones&&active&&props.mode==='pose'&&Math.abs(Math.hypot(p[0]-active.start[0],p[1]-active.start[1])*scale-14*boneUiScale)<4*boneUiScale)return active.boneId
  if(props.bones)for(const b of props.pose.bones??[]){
    const dx=b.end[0]-b.start[0],dy=b.end[1]-b.start[1]
    const k=Math.min(1,Math.max(0,((p[0]-b.start[0])*dx+(p[1]-b.start[1])*dy)/(dx*dx+dy*dy||1)))
    const dist=Math.hypot(p[0]-b.start[0]-k*dx,p[1]-b.start[1]-k*dy)*scale
    if(dist<=distance){closest=b.boneId;distance=dist}
  }
  return closest
}
function hit(p:Point):Selection {
  const closest = hitBone(p)
  if (closest) return {type:'bone',id:closest}
  for(const part of [...props.pose.parts].reverse()){
    if(!part.visible||part.opacity===0)continue
    const l=props.project.manifest.layers.find(l=>l.layerId===part.layerId)!
    if (l.opacity > 0 && hitPart(part, p, l.rect[2], l.rect[3], props.project.alpha.get(l.layerId))) {
      return {type:part.geometry ? 'attachment' : 'layer', id:part.layerId}
    }
  }
  return null
}
function meshSpace() {
  const draft = props.meshDraft!, matrix = meshPart()!.matrix
  const [, ,w,h] = props.project.manifest.layers.find(l => l.layerId === draft.layerId)!.rect
  const size: Point = [w,h], pixelsPerUnit: Point = [scale*Math.hypot(matrix[0],matrix[1]),scale*Math.hypot(matrix[2],matrix[3])]
  return {matrix, size, pixelsPerUnit}
}
function pointerTarget(pointer: MeshCursor, screenPoints?: Point[]) {
  const draft = props.meshDraft!, { matrix, size, pixelsPerUnit } = meshSpace()
  return meshPointerTarget({
    cursor: pointer.at, local: transform(inverse(matrix), ...world(pointer.at)),
    points: draft.points, screenPoints: screenPoints ?? draft.points.map(p => toScreen(transform(matrix,...p))),
    edges: draftEdges.value, size, pixelsPerUnit, touch: pointer.touch, drawing: draft.drawing,
    insert: props.vertexTool === 'insert', triangles: props.triangles, snap: props.snapping && !pointer.alt,
  })
}
const pointer = (e:PointerEvent):MeshCursor => ({at:cursor(e), alt:e.altKey, touch:e.pointerType==='touch'})
let canvasHover: string | undefined
const hoveringBone = ref(false)
function hoverBone(id?: string) {
  hoveringBone.value = !!id
  if (canvasHover !== id) {canvasHover=id;emit('hoverBone',id)}
}
function leave() { hoverBone(); meshCursor=null; if(!drag)guides=[]; schedule() }
function down(e:PointerEvent){
  if(drag||(e.button!==0&&e.button!==1))return
  const at=cursor(e),p=world(at)
  if(space||(!props.meshDraft&&props.tool==='pan')||e.button===1)drag={kind:'pan',at,initial:[...pan]}
  else if (props.meshDraft) {
    if (props.tracing) return
    const draft = props.meshDraft, part = meshPart()
    if (!part) return
    const local = transform(inverse(part.matrix), ...p)
    stage.value?.focus({preventScroll:true})
    meshCursor = pointer(e)
    const target = pointerTarget(meshCursor)
    if (target?.kind === 'vertex') {
      const nearest = target.index
      if (!draft.drawing && props.vertexTool==='delete') drag={kind:'delete',index:nearest}
      else if (draft.drawing || props.vertexTool==='move') {
        emit('beginVertex',nearest)
        const [x,y] = draft.points[nearest]!
        drag={kind:'vertex', index:nearest, at, offset:[x-local[0],y-local[1]], moved:false, closes:target.closes, onEdge:false}
      }
    } else if (target?.kind === 'insert') {
      emit('insertPoint',target.a,target.b,target.point)
    } else if (target?.kind === 'plot') {
      emit('plot',target.point)
    }
  }
  else if(props.mode==='setup'&&props.tool==='bone'){
    const parent=props.pose.bones?.find(b=>props.selected?.type==='bone'&&b.boneId===props.selected.id)
    const snap=!!parent && !e.altKey
    drag={kind:'create',start:snap?parent!.end:p,end:p,parent:parent?.boneId,parentEnd:parent?.end,snap}
  }else{
    const s=hit(p)
    const bone=s?.type==='bone'?props.pose.bones?.find(b=>b.boneId===s.id):null
    if(props.pickingBones) { emit('select',s);return }
    if(bone&&props.mode==='setup'){
      const boneUiScale=Math.min(1.42,Math.max(0.68,Math.pow(zoom,0.34)))
      const tip=Math.hypot(p[0]-bone.end[0],p[1]-bone.end[1])*scale<8*boneUiScale && Math.hypot(p[0]-bone.start[0],p[1]-bone.start[1])*scale>4*boneUiScale
      drag={kind:'place',id:bone.boneId,from:p,start:bone.start,end:bone.end,tip,moved:false}
    }
    if(bone&&props.mode==='pose'){
      const initial=props.rotations[bone.boneId]??0
      drag={kind:'rotate',pivot:bone.start,angle:Math.atan2(p[1]-bone.start[1],p[0]-bone.start[0]),initial}
    }
    emit('select',s)
  }
  if(drag){stage.value?.setPointerCapture(e.pointerId);e.preventDefault()}
  schedule()
}
function move(e:PointerEvent){
  if (!props.meshDraft && !drag && !space && props.tool==='select' && props.bones) hoverBone(hitBone(world(cursor(e))))
  else if (!drag) hoverBone(undefined)
  if (props.meshDraft) meshCursor = pointer(e)
  if(!drag || drag.kind==='delete') {
    if (props.meshDraft) schedule()
    return
  }
  const at=cursor(e),p=world(at)
  if(drag.kind==='pan')pan=[drag.initial[0]+at[0]-drag.at[0],drag.initial[1]+at[1]-drag.at[1]]
  else if (drag.kind === 'vertex') {
    if (!drag.moved && Math.hypot(at[0]-drag.at[0],at[1]-drag.at[1])<2) return
    drag.moved=true
    const part = meshPart()
    if (!part) return
    const local = transform(inverse(part.matrix),...p)
    const {size,pixelsPerUnit}=meshSpace()
    const desired: Point = [local[0]+drag.offset[0],local[1]+drag.offset[1]]
    const enabled=props.snapping&&!e.altKey, radius=snapRadius(e.pointerType==='touch')
    const pts=props.meshDraft!.points
    const result=snapHandle(desired,pts,drag.index,size,pixelsPerUnit,enabled,radius)
    drag.onEdge=false
    if (enabled) {
      const [a,b]=adjacentOutline(drag.index)
      if (a!==undefined && b!==undefined) {
        const screen=(p:Point)=>toScreen(transform(part.matrix,...p))
        const line=projectToEdge(screen(desired),screen(pts[a]!),screen(pts[b]!))
        if (line && line.distance<=radius) {
          result.point=pointOnEdge(pts[a]!,pts[b]!,line.t)
          result.guides=[]; drag.onEdge=true
        }
      }
    }
    guides=result.guides
    emit('plot',result.point,drag.index)
  }
  else if(drag.kind==='place'){
    const dx=p[0]-drag.from[0],dy=p[1]-drag.from[1]
    if (!drag.moved && Math.hypot(dx,dy)*scale<3) return
    drag.moved=true
    const id=drag.id, bone=props.pose.bones!.find(b=>b.boneId===id)!
    if (!drag.tip) drag.start=[bone.start[0]+dx,bone.start[1]+dy]
    drag.end=[bone.end[0]+dx,bone.end[1]+dy]
  }
  else if(drag.kind==='create')drag.end=p
  else {const a=Math.atan2(p[1]-drag.pivot[1],p[0]-drag.pivot[0])-drag.angle;emit('rotate',drag.initial+Math.atan2(Math.sin(a),Math.cos(a))*180/Math.PI)}
  schedule()
}
function up(e:PointerEvent){
  if (drag?.kind==='delete' && props.meshDraft && props.vertexTool==='delete') {
    const target = pointerTarget(pointer(e))
    if (target?.kind==='vertex' && target.index===drag.index) emit('deletePoint',drag.index)
  }
  if (drag?.kind==='vertex') {
    emit('endVertex',false)
    if (drag.closes && !drag.moved) emit('closeContour')
  }
  if(drag?.kind==='place' && drag.moved)emit('place',drag.id,drag.start,drag.end)
  if(drag?.kind==='create')emit('create',drag.start,world(cursor(e)),drag.parent,drag.snap)
  if (e.pointerType === 'touch') meshCursor=null
  guides=[];drag=null;schedule()
}
function cancel(){if(drag?.kind==='vertex')emit('endVertex',true);drag=null;space=false;leave()}
function key(e:KeyboardEvent){
  if(e.key==='Alt' && meshCursor){meshCursor.alt=e.altKey;schedule()}
  if(e.code==='Space'&&stage.value?.matches(':hover')&&!(e.target instanceof HTMLInputElement)){space=true;e.preventDefault();schedule()}
  if(e.key==='Escape')cancel()
}
function keyup(e:KeyboardEvent){
  if(e.key==='Alt' && meshCursor){meshCursor.alt=e.altKey;schedule()}
  if(e.code==='Space'){space=false;schedule()}
}
function finishDrawing() {
  if(props.meshDraft?.drawing && props.meshDraft.points.length>=3) emit('closeContour')
}
function updateScene() {
  const part = meshPart()
  const pose = props.pose
  renderer?.update(part ? {...pose, parts:pose.parts.map(p => p === part
    ? {...p, visible:true, geometry:undefined, mask:undefined, opacity:1}
    : {...p, visible:false})} : pose)
  schedule()
}
watch(() => props.pose, updateScene)
watch(() => [props.pickingBones,props.inspectingBones], () => {canvasHover=undefined})
function focusMesh() {
  const part=meshPart(), id=props.meshDraft?.layerId
  if (!part || !id) return
  const room = framing()
  const [, ,w,h] = props.project.manifest.layers.find(l => l.layerId === id)!.rect
  const corners = [[0,0],[w,0],[0,h],[w,h]].map(([x,y]) => transform(part.matrix,x!,y!))
  const xs = corners.map(pt=>pt[0]), ys = corners.map(pt=>pt[1])
  const target = .94 * Math.min(room.width / (Math.max(...xs)-Math.min(...xs)), room.height / (Math.max(...ys)-Math.min(...ys)))
  zoom = Math.max(.15, target / room.fitScale)
  const [cx,cy] = transform(part.matrix,w/2,h/2), sheet = props.project.manifest.canvas
  pan = [(sheet.width/2-cx)*room.fitScale*zoom, (sheet.height/2-cy)*room.fitScale*zoom]
  paint()
}
watch(() => props.meshDraft?.layerId, id => {
  meshCursor=null;guides=[]
  if (id) {
    previousCamera = {zoom, pan:[...pan]}
    focusMesh()
  } else if (previousCamera) {
    zoom = previousCamera.zoom
    pan = previousCamera.pan
    previousCamera = null
  }
  updateScene()
}, {flush:'post'})
watch(() => props.meshDraft, schedule)

watch(()=>[props.selected,props.highlightBones,props.softnessPreview,props.focusedBone,props.eligible,props.pickingBones,props.bones,props.mode,props.theme,props.triangles,props.activeVertex,props.snapping,props.vertexTool,props.tracing,props.issuePolygons],schedule,{flush:'post'})
onMounted(async()=>{
  import.meta.hot?.on('vite:afterUpdate',refreshGrid)
  observer=new ResizeObserver(schedule);observer.observe(stage.value!);observer.observe(cameraFrame.value!)
  window.addEventListener('keydown',key);window.addEventListener('keyup',keyup);window.addEventListener('blur',cancel)
  try{
    const next=await mountCharacter(surface.value!,props.project.manifest,props.project.files)
    if(disposed){next.destroy();return}
    renderer=next;updateScene()
  }catch(err){if(!disposed)emit('error',String(err))}
})
onBeforeUnmount(()=>{disposed=true;import.meta.hot?.off('vite:afterUpdate',refreshGrid);observer?.disconnect();cancelAnimationFrame(frame);renderer?.destroy();window.removeEventListener('keydown',key);window.removeEventListener('keyup',keyup);window.removeEventListener('blur',cancel)})
</script>
<template>
  <div ref="stage" class="viewport" tabindex="-1" :data-tool="meshDraft ? 'mesh' : pickingBones && tool==='select' ? 'pick' : tool" :data-hover-bone="hoveringBone || undefined" aria-label="角色编辑画布" @pointerdown="down" @pointermove="move" @pointerleave="leave" @pointerup="up" @pointercancel="cancel" @dblclick.prevent="finishDrawing" @wheel.prevent="magnify(Math.exp(-$event.deltaY*($event.deltaMode===1?16:1)*.0015),cursor($event))" @contextmenu.prevent>
    <canvas ref="workspaceGrid" class="workspace-grid" aria-hidden="true"></canvas>
    <div ref="surface" class="pixi-surface" :style="{width:project.manifest.canvas.width+'px',height:project.manifest.canvas.height+'px'}"></div>
    <div ref="documentCorners" class="document-corners" aria-hidden="true"></div>
    <canvas ref="overlay" class="overlay" aria-hidden="true"></canvas>
  </div>
  <div class="canvas-controls">
    <div ref="cameraFrame" class="camera-frame" aria-hidden="true"></div>
    <slot/>
  </div>
</template>
