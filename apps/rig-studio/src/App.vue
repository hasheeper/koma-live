<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { GeometryError, createRig, editRig, exportRigSpec, previewRig, meshFromAlpha, meshFromContour, suggestAlphaThreshold, splitMeshEdge, removeMeshVertex, retessellateOutline, restMesh, type AttachmentMesh, type BoneTransform, type BoneTransforms, type TraceOptions, type Pose, type Point, type RigEdit } from '@koma-rig/rig-core'
import { devWorkspaceProject, directory, mountedDirectory, projectFromSource, example, type Project, type MeshDraft, type Mode, type Tool, type Selection } from './project'
import { DEV_WORKSPACE_ENABLED, extractDroppedPayload, listDevWorks, rememberOpenedSource, type DevWorkSummary } from './local-session'
import { clearRecentDirs, getRecentDir, listRecentDirs, queryDirPermission, readLastSession, requestDirPermission, type RecentDirEntry } from './recent-handles'
import type { LiveWorkBundle } from './live-work'
import Viewport from './Viewport.vue'
import Hierarchy from './Hierarchy.vue'
import BoneBinding from './BoneBinding.vue'
import BoneInspector from './BoneInspector.vue'
import ScrubNumber from './ScrubNumber.vue'
import { bindingPath, boneDeleteBlocker, eligibleEnds, eligibleParents, type Endpoint } from './binding-selection'
import Icon from './Icon.vue'
import BrandMark from './BrandMark.vue'
import MeshInspector from './MeshInspector.vue'
import KomaLive from './KomaLive.vue'
const initialParams = new URLSearchParams(window.location.search)
const initialView = initialParams.get('view') === 'live' ? 'live' : 'studio'
const initialUrlWork = DEV_WORKSPACE_ENABLED ? initialParams.get('work')?.trim() || undefined : undefined
const workspace = ref<'studio' | 'live'>(initialView)
watch(
  workspace,
  (next) => {
    document.title = next === 'live' ? 'Koma Live' : 'Koma Live · Rig'
  },
  { immediate: true },
)
const initialLiveDevWork = ref<string | undefined>(initialUrlWork)
const initialLiveFsEntry = shallowRef<RecentDirEntry | null>(null)
const liveBootReady = ref(initialView !== 'live' || Boolean(initialUrlWork) || !readLastSession())
const recentDirs = shallowRef<RecentDirEntry[]>([])
const devWorks = shallowRef<DevWorkSummary[]>([])
const pendingResume = shallowRef<RecentDirEntry | null>(null)
const persistedLive = shallowRef<{ bundle: LiveWorkBundle; state?: string; studioRev: number } | null>(null)
const studioRevision = ref(0)
const diskRigChanged = ref(false)
const syncToast = ref('')
const dropActive = ref(false)
const project=shallowRef<Project>(),doc=shallowRef<unknown>(),saved=shallowRef<unknown>()
const selected=shallowRef<Selection>(null),boneTransforms=shallowRef<BoneTransforms>({})
const parameters = shallowRef<Record<string, number>>({})
const mode=ref<Mode>('setup'),tool=ref<Tool>('select'),bones=ref(true),side=ref(window.innerWidth>=720)
const saving=ref(false)
const menu=ref(false),error=ref(''),busy=ref(false),theme=ref<'dark'|'light'>(localStorage.getItem('koma-rig-theme')==='light'?'light':'dark')
const issuePolygons = shallowRef<Point[][]>([])
function reportPoseError(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e)
  issuePolygons.value = e instanceof GeometryError ? e.polygons : []
}
function clearNotice() {
  error.value = ''
  issuePolygons.value = []
}
const stage=ref<InstanceType<typeof Viewport>>(),boneInspector=ref<InstanceType<typeof BoneInspector>>(),folder=ref<HTMLInputElement>(),rigFile=ref<HTMLInputElement>()
const scale=ref(100),projectKey=ref(0),before=shallowRef<unknown[]>([]),after=shallowRef<unknown[]>([])
const model=computed(()=>project.value?createRig(project.value.manifest,doc.value):null)
const scrubPose = shallowRef<Pose>()
const pose=computed(()=>scrubPose.value ?? (model.value?(mode.value==='pose'?previewRig(model.value,{bones:boneTransforms.value,parameters:parameters.value}):model.value.pose()):null))
const pickedBone=computed(()=>selected.value?.type==='bone'?model.value?.skeleton.byId.get(selected.value.id):null)
const pickedBinding=computed(()=>selected.value && (selected.value.type==='layer' || selected.value.type==='attachment') ? model.value?.bindings.find(b=>b.layerId===selected.value!.id) : undefined)
const driver=computed(()=>pickedBinding.value?.boneId ?? pickedBinding.value?.boneChain?.at(-1))
const boundBones = computed(() => pickedBinding.value?.boneChain ?? (pickedBinding.value?.boneId ? [pickedBinding.value.boneId] : []))
const pickingBones = ref(false)
const pickingParent = ref(false)
const anyPicking = computed(() => pickingBones.value || pickingParent.value)
const directSlot = ref<Endpoint>()
const softnessPreview = ref<number>()
const endpoint = ref<Endpoint>('start')
const firstPick = ref<string>(), lastPick = ref<string>(), pickIssue = ref('')
const focusedBone = ref<string>(), hoveredBone = ref<string>()
const parentEligible = computed(() => pickedBone.value && model.value
  ? eligibleParents(model.value.skeleton.byId, model.value.skeleton.rest.keys(), pickedBone.value.boneId)
  : new Set<string>())
const deleteBlocker = computed(() => pickedBone.value && model.value
  ? boneDeleteBlocker(model.value, pickedBone.value.boneId)
  : '')
const chainPick = computed(() => {
  if (!firstPick.value || !model.value) return []
  return lastPick.value ? bindingPath(model.value.skeleton.byId, firstPick.value, lastPick.value) : [firstPick.value]
})
const eligible = computed(() => {
  if (pickingParent.value) return parentEligible.value
  const skeleton = model.value?.skeleton
  const fixed = directSlot.value==='start' ? lastPick.value : endpoint.value==='end' ? firstPick.value : undefined
  if (!pickingBones.value || !fixed || !skeleton) return
  return eligibleEnds(skeleton.byId, skeleton.rest.keys(), fixed)
})
const pickPreview = computed(() => {
  if (pickingParent.value) {
    const id = hoveredBone.value
    if (id && parentEligible.value.has(id)) return [id]
    return pickedBone.value?.parentBoneId ? [pickedBone.value.parentBoneId] : []
  }
  if (!pickingBones.value) return boundBones.value
  const id = hoveredBone.value, bones = model.value?.skeleton.byId
  if (!id || !bones || (eligible.value && !eligible.value.has(id))) return chainPick.value
  const anchor = directSlot.value==='start' ? lastPick.value : endpoint.value==='end' ? firstPick.value : undefined
  return anchor ? bindingPath(bones,anchor,id) : [id]
})
const bindingChanged = computed(() => chainPick.value.length !== boundBones.value.length ||
  chainPick.value.some((id, i) => id !== boundBones.value[i]))
function beginBind(slot?: Endpoint) {
  const layer = targetLayer.value
  if (!layer || mode.value!=='setup' || model.value?.settings.get(layer.layerId)?.locked) return
  pickingParent.value = false
  firstPick.value = boundBones.value[0]
  lastPick.value = boundBones.value.length > 1 ? boundBones.value.at(-1) : undefined
  directSlot.value = slot
  endpoint.value = slot ?? 'start'
  pickingBones.value = true
  tool.value = 'select'
  bones.value = true
  pickIssue.value = error.value = ''
  hoveredBone.value = focusedBone.value = undefined
}
function beginParentPick() {
  if (!pickedBone.value || mode.value!=='setup' || !parentEligible.value.size) return
  cancelBind()
  pickingParent.value = true
  tool.value = 'select'
  bones.value = true
  error.value = ''
}
function cancelBind() {
  scrubPose.value = undefined
  pickingBones.value = false
  pickingParent.value = false
  directSlot.value = undefined
  firstPick.value = lastPick.value = hoveredBone.value = focusedBone.value = undefined
  softnessPreview.value = undefined
  pickIssue.value = ''
}
function toggleHierarchy() { side.value = !side.value }
function setEndpoint(value: Endpoint) {
  endpoint.value = value
  pickIssue.value = error.value = ''
}
function clearBinding() {
  firstPick.value = lastPick.value = focusedBone.value = hoveredBone.value = undefined
  setEndpoint('start')
}
function focusBone(id: string) {
  focusedBone.value = id
  bones.value = true
  stage.value?.revealBone(id)
}
function select(item: Selection) {
  if (pickingParent.value) {
    if (item?.type !== 'bone') return
    if (!parentEligible.value.has(item.id)) {
      error.value = '不能将骨骼自身或后代设为父骨'
      return
    }
    reparentBone(item.id)
    return
  }
  if (!pickingBones.value) {
    softnessPreview.value = undefined
    focusedBone.value = hoveredBone.value = undefined
    selected.value = item
    return
  }
  if (item?.type !== 'bone') return
  if (eligible.value && !eligible.value.has(item.id)) {
    pickIssue.value = '所选骨骼与另一端不在同一条父子链上'
    return
  }
  if (directSlot.value) {
    if (directSlot.value === 'start') firstPick.value = item.id
    else lastPick.value = item.id
    pickIssue.value = ''
    if (bindingChanged.value) confirmBind()
    else cancelBind()
    return
  }
  if (endpoint.value === 'start' || !firstPick.value) {
    firstPick.value = item.id
    lastPick.value = undefined
    endpoint.value = 'end'
  } else {
    lastPick.value = item.id === firstPick.value ? undefined : item.id
  }
  focusBone(item.id)
  pickIssue.value = error.value = ''
}
function confirmBind() {
  const layer = targetLayer.value, ids = chainPick.value
  if (!layer || !pickingBones.value || !bindingChanged.value || pickIssue.value) return
  let command: RigEdit
  if (!ids.length) command = {op:'unbind', layerId:layer.layerId}
  else if (ids.length === 1) command = {op:'bind', layerId:layer.layerId, boneId:ids[0]!}
  else command = {op:'bind-chain', layerId:layer.layerId, boneChain:ids, jointSoftnessPx:pickedBinding.value?.jointSoftnessPx}
  if (edit(command)) cancelBind()
}
function soften(width:number) {
  const b=pickedBinding.value
  if(b?.boneChain && Number.isFinite(width) && width>0)edit({op:'bind-chain',layerId:b.layerId,boneChain:b.boneChain,jointSoftnessPx:width})
}
const selectedDeformer = computed(() => {
  if (selected.value?.type !== 'attachment') return
  return model.value?.bindings.find(b => b.layerId === selected.value?.id)?.deformer
})
const meshParameter = computed(() => model.value?.caps.parameters.find(p => p.id === selectedDeformer.value?.parameter))
function setBonePoseProp(prop:'rotation'|'x'|'y'|'scaleX'|'scaleY', value:number | undefined, commit=false) {
  if (value===undefined) { scrubPose.value=undefined; return }
  const bone = pickedBone.value
  if (!model.value || mode.value!=='pose' || !bone) return
  const nextVal = prop==='scaleX' || prop==='scaleY' ? Math.max(0.05, value) : value
  const current: BoneTransform = boneTransforms.value[bone.boneId] ?? {}
  const nextBones: BoneTransforms = { ...boneTransforms.value, [bone.boneId]: { ...current, [prop]: nextVal } }
  try {
    const next = previewRig(model.value, { bones: nextBones, parameters: parameters.value })
    if (commit) { boneTransforms.value = nextBones; scrubPose.value = undefined }
    else scrubPose.value = next
    clearNotice()
  } catch (e) { reportPoseError(e) }
}
function setMeshParamValue(value:number | undefined, commit=false) {
  if (value===undefined) { scrubPose.value=undefined; return }
  const parameter = meshParameter.value
  if (!model.value || mode.value!=='pose' || !parameter) return
  const values = { ...parameters.value, [parameter.id]: value }
  try {
    const next = previewRig(model.value, { bones: boneTransforms.value, parameters: values })
    if (commit) { parameters.value = values; scrubPose.value = undefined }
    else scrubPose.value = next
    clearNotice()
  } catch (e) { reportPoseError(e) }
}
function setBoneProp(prop:'x'|'y'|'rotation'|'length', value:number | undefined, commit=false) {
  const bone = pickedBone.value
  if (!bone || !project.value || mode.value!=='setup') { scrubPose.value=undefined; return }
  if (value===undefined) { scrubPose.value=undefined; return }
  const nextVal = prop==='length' ? Math.max(0, value) : value
  const cmd: RigEdit = {op:'edit-bone', boneId:bone.boneId, changes:{[prop]:nextVal}}
  if (commit) {
    scrubPose.value=undefined
    edit(cmd)
    return
  }
  try {
    const nextDoc = editRig(project.value.manifest, doc.value, [cmd])
    scrubPose.value = createRig(project.value.manifest, nextDoc).pose()
    error.value = ''
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
const meshDraft = shallowRef<MeshDraft | null>(null)
const targetLayer = computed(() => selected.value && (selected.value.type === 'layer' || selected.value.type === 'attachment')
  ? project.value?.manifest.layers.find(l => l.layerId === selected.value?.id) : undefined)

const vertexTools = [
  {mode:'move',label:'调整顶点',tip:'拖动顶点 (V)',icon:'select-cursor'},
  {mode:'insert',label:'加点',tip:'移动预览新边，点击加点 (A)',icon:'vertex-add'},
  {mode:'delete',label:'删点',tip:'点击移除顶点 (D)',icon:'vertex-remove'},
] as const
const activeVertex = ref<number|null>(null)
const snapping = ref(true)
const vertexTool = ref<'move'|'insert'|'delete'>('move')
const meshUndo = shallowRef<MeshDraft[]>([]), meshRedo = shallowRef<MeshDraft[]>([])
let beforeDrag: MeshDraft | null = null
function checkpoint(draft:MeshDraft) {
  meshUndo.value = [...meshUndo.value,draft]
  meshRedo.value = []
}
function changeDraft(next:MeshDraft) {
  if (meshDraft.value) checkpoint(meshDraft.value)
  meshDraft.value = next
  if (activeVertex.value!==null && activeVertex.value>=next.points.length) activeVertex.value=null
  error.value=''
}
function stepDraft(redo:boolean) {
  const from=redo?meshRedo:meshUndo, to=redo?meshUndo:meshRedo
  if (!from.value.length || !meshDraft.value) return
  to.value=[...to.value,meshDraft.value]
  meshDraft.value=from.value.at(-1)!
  activeVertex.value=null
  from.value=from.value.slice(0,-1)
  vertexTool.value='move';error.value=''
}
function startMesh() {
  cancelBind()
  const layer = targetLayer.value
  if (!layer || mode.value !== 'setup' || model.value?.settings.get(layer.layerId)?.locked) return
  meshUndo.value=[];meshRedo.value=[];beforeDrag=null;activeVertex.value=null;vertexTool.value='move';traceOptions.value=undefined
  const savedMesh = model.value?.bindings.find(b => b.layerId === layer.layerId)?.mesh
  error.value = ''
  meshDraft.value = { layerId:layer.layerId, drawing:!savedMesh, points:savedMesh?.points ?? [], indices:savedMesh?.indices ?? [] }
}
function drawContour() {
  if (meshDraft.value && !meshDraft.value.drawing) {
    changeDraft({...meshDraft.value, drawing:true, points:[], indices:[]});vertexTool.value='move'
    error.value = ''
  }
}
const traceOpen = ref(false), triangles = ref(false), traceReady = ref(false)
const traceOptions = shallowRef<TraceOptions>()
const tracePreview = shallowRef<AttachmentMesh | null>(null)
const traceSource = computed(() => {
  const id = meshDraft.value?.layerId
  if (!id || !project.value) return
  return project.value.coverageAlpha.get(id) ?? project.value.alpha.get(id)
})
const canvasDraft = computed(() => meshDraft.value && traceOpen.value
  ? {...meshDraft.value, drawing:false, points:tracePreview.value?.points ?? [], indices:tracePreview.value?.indices ?? []}
  : meshDraft.value)
const vertexPreview = shallowRef<Point>()
const viewportDraft = computed(() => {
  const draft=canvasDraft.value, point=vertexPreview.value, index=activeVertex.value
  if (!draft || !point || index===null || traceOpen.value) return draft
  const points=draft.points.slice()
  points[index]=point
  return {...draft,points}
})
function openTrace() { vertexTool.value='move';traceReady.value=false; tracePreview.value=null; traceOpen.value=true; error.value='' }
function previewTrace(mesh:AttachmentMesh|null) { tracePreview.value=mesh; traceReady.value=!!mesh }
function finishTrace() {
  if (traceOpen.value && traceReady.value && tracePreview.value) acceptTrace(tracePreview.value)
}
function setVertexTool(tool:'move'|'insert'|'delete') { finishTrace();vertexTool.value=tool }

function acceptTrace(mesh:AttachmentMesh) {
  if (meshDraft.value) changeDraft({...meshDraft.value, drawing:false, ...mesh})
  activeVertex.value=null
  vertexTool.value='move'
  traceOpen.value = false
}
function plotPoint(point:Point, index?:number) {
  const draft = meshDraft.value
  if (!draft) return
  const points = draft.points.slice()
  if (index === undefined) points.push(point)
  else points[index] = point
  if (index===undefined) { changeDraft({...draft,points}); activeVertex.value=points.length-1 }
  else meshDraft.value={...draft,points}
  error.value = ''
}
function beginVertexDrag(index:number) { finishTrace();beforeDrag=meshDraft.value;activeVertex.value=index }
function setVertexPosition(point:Point) {
  const id=activeVertex.value
  if (id===null) return
  beginVertexDrag(id);plotPoint(point,id);endVertexDrag(false)
}
function endVertexDrag(cancelled:boolean) {
  const old=beforeDrag, draft=meshDraft.value, layer=targetLayer.value
  beforeDrag=null
  if (!draft || !old || draft===old || !layer) return
  if (cancelled) {meshDraft.value=old;return}
  try {
    if (!draft.drawing) {
      const next=retessellateOutline(draft)
      restMesh(next,layer.rect[2],layer.rect[3])
      meshDraft.value={...draft,...next}
    }
    checkpoint(old)
  } catch (err) { meshDraft.value=old;error.value=err instanceof Error?err.message:String(err) }
}
function topologyEdit(action: (draft:MeshDraft)=>AttachmentMesh) {
  const draft=meshDraft.value, layer=targetLayer.value
  if (!draft || !layer) return
  try {
    const mesh=action(draft)
    restMesh(mesh,layer.rect[2],layer.rect[3])
    changeDraft({...draft,...mesh,drawing:false})
  } catch (err) {error.value=err instanceof Error?err.message:String(err)}
}
function closeContour() { topologyEdit(draft=>meshFromContour(draft.points)); vertexTool.value='move' }
function insertPoint(a:number,b:number,pt:Point) {
  finishTrace()
  const old=meshDraft.value
  topologyEdit(draft=>retessellateOutline(splitMeshEdge(draft,a,b,pt)))
  if(meshDraft.value!==old) activeVertex.value=old!.points.length
}
function deletePoint(id:number) { finishTrace();topologyEdit(draft=>removeMeshVertex(draft,id));activeVertex.value=null }
function cancelMesh() { vertexPreview.value=undefined;traceOpen.value=false; meshDraft.value=null; error.value='' }
function applyMesh() {
  if (traceOpen.value && !traceReady.value) return
  finishTrace()
  const draft = meshDraft.value
  if (!draft) return
  try {
    const mesh = draft.drawing ? meshFromContour(draft.points) : {points:draft.points, indices:draft.indices}
    if (!edit({op:'set-mesh', layerId:draft.layerId, mesh})) return
    selected.value = {type:'attachment', id:draft.layerId}
    cancelMesh()
  } catch (err) { error.value = err instanceof Error ? err.message : String(err) }
}
function clearMesh() {
  const draft = meshDraft.value
  if (!draft) return
  if (!edit({op:'set-mesh', layerId:draft.layerId, mesh:null})) return
  selected.value = {type:'layer', id:draft.layerId}
  cancelMesh()
}
function editMeshLayer(layerId: string) {
  selected.value = {type:'attachment', id:layerId}
  startMesh()
}
const hasSavedMesh = computed(() => !!meshDraft.value && !!model.value?.bindings.find(b => b.layerId === meshDraft.value?.layerId)?.mesh)
const canAutoMeshLayer = computed(() => {
  const layer = targetLayer.value
  if (!layer || mode.value !== 'setup' || pickingBones.value) return false
  if (boundBones.value.length <= 1 || pickedBinding.value?.mesh) return false
  return !model.value?.settings.get(layer.layerId)?.locked
})
const activeLiveSession = computed(() =>
  persistedLive.value && persistedLive.value.studioRev === studioRevision.value
    ? { bundle: persistedLive.value.bundle, state: persistedLive.value.state }
    : null,
)
const pickedPoseTransform = computed<BoneTransform>(() => pickedBone.value ? boneTransforms.value[pickedBone.value.boneId] ?? {} : {})
const boneRotations = computed(() => Object.fromEntries(Object.entries(boneTransforms.value).map(([id, t]) => [id, t.rotation ?? 0])))
const dirty=computed(()=>!!project.value&&doc.value!==saved.value)
let generation=0
let toastTimer: number | undefined
let studioWatchTimer: number | undefined
let checkingStudioRig = false
let dragDepth = 0

function flashToast(text: string) {
  syncToast.value = text
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    syncToast.value = ''
    toastTimer = undefined
  }, 2000)
}
function syncUrlWork(devPath?: string) {
  const url = new URL(window.location.href)
  if (devPath) url.searchParams.set('work', devPath)
  else url.searchParams.delete('work')
  window.history.replaceState(null, '', url)
}
async function refreshSources() {
  const [recents, works] = await Promise.all([listRecentDirs(), listDevWorks()])
  recentDirs.value = recents
  devWorks.value = works
}
async function handleClearRecent() {
  await clearRecentDirs()
  recentDirs.value = []
  pendingResume.value = null
}
function reset(docValue:unknown){scrubPose.value=undefined;cancelBind();clearNotice();diskRigChanged.value=false;doc.value=docValue;saved.value=docValue;before.value=[];after.value=[];boneTransforms.value={};parameters.value={};mode.value='setup';tool.value='select';bones.value=true;selected.value=null}
async function load(open:()=>Promise<Project>, options?: { remember?: boolean; updateUrl?: boolean; keepLiveSync?: boolean }){
  menu.value=false
  if(dirty.value&&!window.confirm('当前骨架有未导出的修改。继续切换企划？'))return
  const job=++generation;busy.value=true;error.value=''
  try{
    const next=await open();if(job!==generation)return
    if (options?.remember && next.source && next.layout) {
      await rememberOpenedSource(next.source, next.layout)
      recentDirs.value = await listRecentDirs()
      pendingResume.value = null
    }
    if (options?.updateUrl !== false) {
      syncUrlWork(next.source?.devPath)
    }
    reset(next.rig);project.value=next;projectKey.value++;studioRevision.value++
    if (options?.keepLiveSync && persistedLive.value) {
      persistedLive.value = { ...persistedLive.value, studioRev: studioRevision.value }
    }
    const visible = createRig(next.manifest, next.rig).pose().parts.filter(part => part.visible).reverse()
    const mesh = visible.find(part => part.geometry)
    const firstLayer = visible[0]?.layerId
    if (mesh) selected.value = {type:'attachment', id:mesh.layerId}
    else if (firstLayer) selected.value = {type:'layer', id:firstLayer}
  }catch(e){if(job===generation && !(e instanceof DOMException && e.name==='AbortError'))error.value=e instanceof Error?e.message:String(e)}
  finally{if(job===generation)busy.value=false}
}
function edit(command:RigEdit | RigEdit[]){
  if(!project.value||busy.value||mode.value!=='setup')return false
  const commands = Array.isArray(command) ? command : [command]
  try{
    const next=editRig(project.value.manifest,doc.value,commands)
    before.value=[...before.value,doc.value];after.value=[];doc.value=next;studioRevision.value++;error.value='';return true
  }catch(e){error.value=e instanceof Error?e.message:String(e);return false}
}
function travel(undo:boolean){
  cancelBind()
  if(mode.value!=='setup'||busy.value)return
  const [from,to]=undo?[before,after]:[after,before]
  if(!from.value.length)return
  to.value=[...to.value,doc.value];doc.value=from.value.at(-1);from.value=from.value.slice(0,-1);studioRevision.value++
  if(selected.value?.type==='bone'&&!model.value?.skeleton.byId.has(selected.value.id))selected.value=null
}
function autoMeshSelectedLayer() {
  const layer = targetLayer.value
  const current = project.value
  if (!layer || !current || !canAutoMeshLayer.value) return
  const alpha = current.coverageAlpha.get(layer.layerId) ?? current.alpha.get(layer.layerId)
  if (!alpha) {
    error.value = '当前图层缺少透明通道数据，无法自动生成轮廓网格。'
    return
  }
  try {
    const mesh = meshFromAlpha(alpha, layer.rect[2], layer.rect[3], {
      detail: 28,
      concavity: 10,
      refinement: 50,
      alphaThreshold: suggestAlphaThreshold(alpha),
      padding: 4,
    })
    if (edit({ op: 'set-mesh', layerId: layer.layerId, mesh })) {
      selected.value = { type: 'attachment', id: layer.layerId }
      flashToast(`已生成骨链轮廓网格 · ${mesh.points.length} 顶点`)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
function switchMode(next:Mode){
  if(mode.value===next)return
  scrubPose.value=undefined;cancelBind();clearNotice();mode.value=next;tool.value='select';boneTransforms.value={};parameters.value={}
  if(next==='pose'&&driver.value&&!selectedDeformer.value)selected.value={type:'bone',id:driver.value}
}
function rotate(v:number){
  if (Number.isFinite(v) && pickedBone.value) setBonePoseProp('rotation', v, true)
}
function renameBone(name:string) {
  const bone = pickedBone.value
  if (!bone || mode.value!=='setup') return
  edit({op:'edit-bone', boneId:bone.boneId, changes:{name}})
}
async function focusRenameBone(id:string) {
  select({type:'bone', id})
  await nextTick()
  boneInspector.value?.startRename()
}
function reparentBone(parentBoneId:string | null) {
  const bone = pickedBone.value
  if (!bone || mode.value!=='setup') return
  if ((bone.parentBoneId ?? null) === parentBoneId) {
    pickingParent.value = false
    hoveredBone.value = undefined
    return
  }
  if (edit({op:'reparent', boneId:bone.boneId, parentBoneId})) {
    pickingParent.value = false
    hoveredBone.value = undefined
  }
}
function removeBone() {
  const bone = pickedBone.value
  if (!bone || mode.value!=='setup') return
  if (deleteBlocker.value) {
    error.value = deleteBlocker.value
    return
  }
  const parentId = bone.parentBoneId
  if (edit({op:'remove-bone', boneId:bone.boneId})) {
    pickingParent.value = false
    hoveredBone.value = focusedBone.value = undefined
    selected.value = parentId ? {type:'bone', id:parentId} : null
  }
}
function addBone(start:Point,end:Point,parent?:string,snap=true){
  let n=(model.value?.skeleton.byId.size??0)+1
  while(model.value?.skeleton.byId.has('bone-'+n))n++
  const id='bone-'+n
  const cmd: RigEdit = {op:'add-bone',boneId:id,name:'骨骼 '+n,start,end,parentBoneId:parent,...(parent && !snap ? {snap:false} : {})}
  if(edit(cmd))selected.value={type:'bone',id}
}
async function openFolder(){
  const picker=(window as Window & {showDirectoryPicker?:(options:{mode:'readwrite'})=>Promise<FileSystemDirectoryHandle>}).showDirectoryPicker
  menu.value=false
  if (!picker) {folder.value?.click();return}
  await load(async()=>mountedDirectory(await picker.call(window,{mode:'readwrite'})), { remember: true })
}
async function openRecentInStudio(entry: RecentDirEntry) {
  menu.value = false
  try {
    let ok = (await queryDirPermission(entry.handle, 'readwrite')) === 'granted'
    if (!ok) ok = await requestDirPermission(entry.handle, 'readwrite')
    if (!ok) {
      ok = (await queryDirPermission(entry.handle, 'read')) === 'granted' || (await requestDirPermission(entry.handle, 'read'))
    }
    if (!ok) {
      error.value = `未获得目录访问权限 · ${entry.name}`
      return
    }
    await load(() => mountedDirectory(entry.handle, entry.id), { remember: true })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
async function openDevInStudio(relPath: string) {
  await load(() => devWorkspaceProject(relPath), { remember: true })
}
async function reloadDiskRig(silent = false) {
  const current = project.value
  if (!current?.reloadRig) return
  menu.value = false
  if (!silent && dirty.value && !window.confirm('当前骨架有未保存的修改。确定以目录中的 rig.json 覆盖？')) return
  try {
    const fresh = await current.reloadRig()
    if (project.value !== current) return
    scrubPose.value = undefined
    cancelBind()
    clearNotice()
    diskRigChanged.value = false
    doc.value = fresh
    saved.value = fresh
    before.value = []
    after.value = []
    studioRevision.value++
    if (selected.value?.type === 'bone' && !model.value?.skeleton.byId.has(selected.value.id)) {
      selected.value = null
    }
    flashToast(silent ? '已自动同步目录中的 rig.json' : '已从目录重新载入 rig.json')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
async function pollStudioRig() {
  if (
    workspace.value !== 'studio' ||
    document.visibilityState !== 'visible' ||
    busy.value ||
    saving.value ||
    meshDraft.value ||
    anyPicking.value ||
    checkingStudioRig ||
    !project.value?.checkRigChanged
  ) {
    return
  }
  const current = project.value
  checkingStudioRig = true
  try {
    const changed = await current.checkRigChanged!()
    if (!changed || project.value !== current) return
    if (!dirty.value) {
      await reloadDiskRig(true)
    } else {
      diskRigChanged.value = true
    }
  } catch {
    // Ignore transient file locks during external writes
  } finally {
    checkingStudioRig = false
  }
}
function handleStudioDragEnter(e: DragEvent) {
  if (meshDraft.value || !e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  dragDepth++
  dropActive.value = true
}
function handleStudioDragOver(e: DragEvent) {
  if (meshDraft.value || !e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function handleStudioDragLeave(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropActive.value = false
}
async function handleStudioDrop(e: DragEvent) {
  e.preventDefault()
  dragDepth = 0
  dropActive.value = false
  if (meshDraft.value) return
  try {
    const payload = await extractDroppedPayload(e.dataTransfer)
    if (!payload) return
    if (payload.kind === 'directory') {
      await load(() => mountedDirectory(payload.handle), { remember: true })
      return
    }
    if (/\.json$/i.test(payload.file.name)) {
      importRig(payload.file)
      return
    }
    error.value = '请拖入作品/切片目录（含 koma-work.json 或 manifest.json）或 rig.json。'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
async function save(){
  const current=project.value, snapshot=doc.value
  if(!current?.writeRig){downloadRig();return}
  if(saving.value)return
  saving.value=true;menu.value=false
  try {
    await current.writeRig(JSON.stringify(snapshot,null,2)+'\n')
    if(project.value===current){saved.value=snapshot;diskRigChanged.value=false;error.value='';flashToast('已保存 rig.json 到目录')}
  }catch(e){error.value=String(e)}finally{saving.value=false}
}
function downloadJson(filename:string, data:unknown) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}))
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
function downloadRig(){
  if(!project.value)return
  downloadJson('rig.json', doc.value)
  if(!project.value.writeRig)saved.value=doc.value;menu.value=false
}
function downloadSpec(){
  if(!project.value)return
  try {
    downloadJson('rig-spec.json', exportRigSpec(project.value.manifest, doc.value))
    menu.value=false; clearNotice()
  } catch(e) { error.value = e instanceof Error ? e.message : String(e) }
}
function importRig(file?:File){
  if(!file||!project.value)return
  const current=project.value
  void load(async()=>{const rig=JSON.parse(await file.text());createRig(current.manifest,rig).pose();return {...current,rig}}, { updateUrl: false })
}
function openFiles(e:Event,kind:'folder'|'rig'){
  const el=e.target as HTMLInputElement,files=Array.from(el.files??[]);el.value=''
  if(!files.length)return
  if(kind==='folder')void load(()=>directory(files));else importRig(files[0])
}
function chooseTool(t:Tool) {
  if (t==='bone') { cancelBind(); bones.value=true }
  tool.value=t
}
function setTheme(){theme.value=theme.value==='dark'?'light':'dark';localStorage.setItem('koma-rig-theme',theme.value)}
function switchWorkspace(next: 'studio' | 'live') {
  if (workspace.value === next) return
  scrubPose.value = undefined
  menu.value = false
  if (next === 'live') {
    initialLiveDevWork.value = undefined
    initialLiveFsEntry.value = null
    liveBootReady.value = true
  }
  workspace.value = next
  const url = new URL(window.location.href)
  if (next === 'live') url.searchParams.set('view', 'live')
  else url.searchParams.delete('view')
  window.history.replaceState(null, '', url)
  if (next === 'studio' && !project.value) void load(() => example('chain'), { updateUrl: false })
}
function handleBackToStudio(snapshot: { bundle?: LiveWorkBundle; state: string }) {
  persistedLive.value = snapshot.bundle
    ? { bundle: snapshot.bundle, state: snapshot.state, studioRev: studioRevision.value }
    : null
  scrubPose.value = undefined
  menu.value = false
  workspace.value = 'studio'
  const url = new URL(window.location.href)
  url.searchParams.delete('view')
  window.history.replaceState(null, '', url)

  const liveSource = snapshot.bundle?.source
  if (liveSource && liveSource.sourceKind !== 'files') {
    const sameSource = project.value?.source?.id === liveSource.id
    if (!sameSource && (!project.value || !dirty.value)) {
      void load(() => projectFromSource(liveSource), { remember: false, keepLiveSync: true })
      return
    }
  }
  if (!project.value) {
    void load(() => example('chain'), { updateUrl: false })
  }
}
async function handleLiveWorkChanged(info: { devPath?: string; clearResume?: boolean }) {
  if (info.clearResume) pendingResume.value = null
  syncUrlWork(info.devPath)
  recentDirs.value = await listRecentDirs()
}
function shortcut(e:KeyboardEvent){
  if (workspace.value === 'live') return
  if (meshDraft.value) {
    if (traceOpen.value) {
      if (e.key === 'Escape') traceOpen.value=false
      return
    }
    if (e.key === 'Escape') { cancelMesh(); return }
    if ((e.target as HTMLElement)?.closest('input,select,textarea,[contenteditable=true]')) return
    const id=activeVertex.value, pt=id===null?null:meshDraft.value.points[id]
    const delta:Record<string,Point>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}
    if (pt && delta[e.key] && targetLayer.value) {
      e.preventDefault()
      const [dx,dy]=delta[e.key]!, step=e.shiftKey?10:1, [, ,w,h]=targetLayer.value.rect
      setVertexPosition([Math.max(0,Math.min(w,pt[0]+dx*step)),Math.max(0,Math.min(h,pt[1]+dy*step))])
    }
    else if (id!==null && !meshDraft.value.drawing && (e.key==='Delete' || e.key==='Backspace')) {e.preventDefault();deletePoint(id)}
    else if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='z') {e.preventDefault();stepDraft(e.shiftKey)}
    else if (e.key === 'Backspace' && meshDraft.value.drawing) {e.preventDefault();stepDraft(false)}
    else if (!meshDraft.value.drawing && !e.ctrlKey && !e.metaKey && ['v','a','d'].includes(e.key.toLowerCase())) {
      setVertexTool(e.key.toLowerCase()==='a'?'insert':e.key.toLowerCase()==='d'?'delete':'move')
    }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      if (meshDraft.value.drawing) { if (meshDraft.value.points.length >= 3) closeContour() }
      else applyMesh()
    }
    return
  }
  if(e.key==='Escape'){cancelBind();menu.value=false;tool.value='select';return}
  if((e.target as HTMLElement)?.closest('input,select,textarea,[contenteditable=true]'))return
  const k=e.key.toLowerCase()
  if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();travel(!e.shiftKey);return}
  if((e.ctrlKey||e.metaKey)&&k==='s'){e.preventDefault();save();return}
  if(e.altKey||e.ctrlKey||e.metaKey)return
  if(e.key==='F2' && mode.value==='setup' && pickedBone.value && !anyPicking.value){e.preventDefault();void boneInspector.value?.startRename();return}
  if((e.key==='Delete'||e.key==='Backspace') && mode.value==='setup' && pickedBone.value && !anyPicking.value){e.preventDefault();removeBone();return}
  if(k==='v')chooseTool('select');else if(k==='b'&&mode.value==='setup')chooseTool('bone');else if(k==='h')chooseTool('pan');else if(k==='f')stage.value?.fit()
}
function onStudioFocus() {
  void pollStudioRig()
}
function onStudioVisibility() {
  if (document.visibilityState === 'visible') void pollStudioRig()
}
async function bootWorkspace() {
  await refreshSources()

  // 1. Explicit ?work=<relPath> in dev mode always wins
  if (initialUrlWork) {
    if (workspace.value === 'studio') {
      await load(() => devWorkspaceProject(initialUrlWork), { remember: true })
    } else {
      liveBootReady.value = true
    }
    return
  }

  // 2. Restore last opened local directory / dev workspace if available
  const last = readLastSession()
  if (last?.kind === 'dev' && DEV_WORKSPACE_ENABLED && devWorks.value.some((w) => w.path === last.id)) {
    if (workspace.value === 'studio') {
      await load(() => devWorkspaceProject(last.id), { remember: true })
    } else {
      initialLiveDevWork.value = last.id
      liveBootReady.value = true
    }
    return
  }

  if (last?.kind === 'fs') {
    const entry = await getRecentDir(last.id)
    if (entry) {
      const perm = await queryDirPermission(entry.handle, 'read')
      if (perm === 'granted') {
        if (workspace.value === 'studio') {
          await load(() => mountedDirectory(entry.handle, entry.id), { remember: true })
        } else {
          initialLiveFsEntry.value = entry
          liveBootReady.value = true
        }
        return
      }
      if (perm === 'prompt') {
        pendingResume.value = entry
      }
    }
  }

  // 3. Fallback to built-in sample
  if (workspace.value === 'studio') {
    await load(() => example('chain'), { updateUrl: false })
  } else {
    liveBootReady.value = true
  }
}
onMounted(() => {
  window.addEventListener('keydown', shortcut)
  window.addEventListener('focus', onStudioFocus)
  document.addEventListener('visibilitychange', onStudioVisibility)
  studioWatchTimer = window.setInterval(() => void pollStudioRig(), 1500)
  void bootWorkspace()
})
onBeforeUnmount(() => {
  generation++
  window.removeEventListener('keydown', shortcut)
  window.removeEventListener('focus', onStudioFocus)
  document.removeEventListener('visibilitychange', onStudioVisibility)
  if (studioWatchTimer !== undefined) window.clearInterval(studioWatchTimer)
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>
<template>
  <KomaLive
    v-if="workspace === 'live' && liveBootReady"
    :theme="theme"
    :studio-project="project"
    :studio-rig="doc"
    :studio-dirty="dirty"
    :saved-session="activeLiveSession"
    :initial-dev-work="initialLiveDevWork"
    :initial-fs-entry="initialLiveFsEntry"
    :pending-resume="pendingResume"
    :recent-dirs="recentDirs"
    :dev-works="devWorks"
    @back-to-studio="handleBackToStudio"
    @toggle-theme="setTheme"
    @work-changed="handleLiveWorkChanged"
    @dismiss-resume="pendingResume = null"
    @clear-recent="handleClearRecent"
  />
  <main v-else-if="workspace === 'live'" class="studio koma-live" :data-theme="theme">
    <div class="notice" role="status">正在恢复上次动帧作品…</div>
  </main>
  <main v-else class="studio" :data-theme="theme" :class="{'tree-open':side}">
    <div class="commands">
      <div v-if="menu" class="menu-scrim" @click="menu=false"></div>
      <div class="project-island">
        <BrandMark />
        <div class="file-area">
          <button class="file-button" :disabled="!!meshDraft" :aria-expanded="menu" aria-label="企划菜单"
            :title="(project?.name ?? '企划') + (dirty ? ' · 有未导出的修改' : '')" @click="menu=!menu">
            <Icon name="folder" class="file-folder"/>
            <span class="file-name">{{ project?.name ?? '企划' }}</span>
            <span class="file-status" :class="{ dirty }" aria-hidden="true"></span>
            <Icon name="chevron" class="file-caret"/>
          </button>
          <nav v-if="menu" class="file-menu" aria-label="企划操作">
            <button @click="openFolder"><Icon name="folder"/>打开作品 / 切片目录…</button>
            <button :disabled="!project" @click="menu=false;rigFile?.click()"><Icon name="import"/>载入当前素材的 rig.json…</button>
            <button v-if="project?.reloadRig" :disabled="busy" @click="reloadDiskRig(false)"><Icon name="reload"/>从目录重新载入 rig.json</button>
            <button v-if="project?.writeRig" :disabled="saving" @click="save">保存到目录</button>
            <button :disabled="!project" @click="downloadRig"><Icon name="download"/>导出 rig.json</button>
            <button :disabled="!project" @click="downloadSpec"><Icon name="download"/>导出 AI 驱动清单 (rig-spec.json)</button>

            <template v-if="devWorks.length">
              <hr>
              <div class="menu-section-head"><span>本地工作区</span></div>
              <button v-for="w in devWorks" :key="w.path" :class="{ active: project?.source?.devPath === w.path }" :title="w.path" @click="openDevInStudio(w.path)">
                <Icon name="folder"/><span class="menu-item-label">{{ w.title }}</span>
              </button>
            </template>

            <template v-if="recentDirs.length">
              <hr>
              <div class="menu-section-head">
                <span>最近打开</span>
                <button class="menu-clear-btn" title="清空最近记录" @click.stop="handleClearRecent">清空</button>
              </div>
              <button v-for="entry in recentDirs" :key="entry.id" :class="{ active: project?.source?.id === entry.id }" :title="entry.name" @click="openRecentInStudio(entry)">
                <Icon name="recent"/><span class="menu-item-label">{{ entry.title }}</span>
              </button>
            </template>

            <hr>
            <button @click="load(()=>example('chain'))">整张纸带 · 骨链</button><button @click="load(()=>example('gbot'))">多图层练习</button><button @click="load(()=>example('paper'))">纸条 · 已绑定</button><button @click="load(()=>example('empty'))">纸条 · 空骨架</button>
          </nav>
        </div>
        <div class="history-controls"><button title="撤销 (⌘/Ctrl Z)" aria-label="撤销" :disabled="meshDraft ? traceOpen || !meshUndo.length : !before.length || mode==='pose'" @click="meshDraft?stepDraft(false):travel(true)"><Icon name="undo"/></button><button title="重做 (⌘/Ctrl Shift Z)" aria-label="重做" :disabled="meshDraft ? traceOpen || !meshRedo.length : !after.length || mode==='pose'" @click="meshDraft?stepDraft(true):travel(false)"><Icon name="redo"/></button></div>
      </div>
      <div class="modes" role="group" aria-label="工作模式"><button :disabled="!!meshDraft" :aria-pressed="mode==='setup'" @click="switchMode('setup')">搭建</button><button :disabled="!!meshDraft" :aria-pressed="mode==='pose'" @click="switchMode('pose')">试动</button></div>
      <div class="view-controls">
        <button class="live-switch-btn" :disabled="!!meshDraft" aria-label="切换到动帧 Live" title="切换到 Koma Live 动帧工坊" @click="switchWorkspace('live')"><Icon name="live"/><span>动帧</span></button>
        <i class="live-divider" aria-hidden="true"></i>
        <button aria-label="切换主题" title="切换主题" @click="setTheme"><Icon :name="theme==='dark'?'sun':'moon'"/></button>
        <button aria-label="切换层级树" :disabled="!!meshDraft" title="切换层级树" :aria-expanded="side" @click="toggleHierarchy()"><Icon name="sidebar"/></button>
      </div>
    </div>
    <div class="desk" :class="{'editing-mesh':!!meshDraft}">
      <section
        class="stage"
        :class="{ 'drop-active': dropActive }"
        aria-label="画布"
        @dragenter="handleStudioDragEnter"
        @dragover="handleStudioDragOver"
        @dragleave="handleStudioDragLeave"
        @drop="handleStudioDrop"
      >
        <Viewport v-if="project&&model&&pose" :key="projectKey" ref="stage" :project="project" :pose="pose" :selected="selected" :driver="anyPicking ? undefined : driver" :highlight-bones="pickPreview" :softness-preview="softnessPreview" :focused-bone="hoveredBone ?? focusedBone" :focus-name="model.skeleton.byId.get(hoveredBone ?? focusedBone ?? '')?.name" @hover-bone="id=>hoveredBone=id" :eligible="eligible" :picking-bones="anyPicking" :inspecting-bones="!!targetLayer && mode==='setup' && !meshDraft" :mode="mode" :tool="tool" :bones="bones" :rotations="boneRotations" :theme="theme" :issue-polygons="issuePolygons" :mesh-draft="viewportDraft" :tracing="traceOpen && !traceReady" :triangles="triangles" :vertex-tool="vertexTool" :active-vertex="activeVertex" :snapping="snapping" @plot="plotPoint" @close-contour="closeContour" @begin-vertex="beginVertexDrag" @end-vertex="endVertexDrag" @insert-point="insertPoint" @delete-point="deletePoint" @select="select" @place="(boneId,start,end)=>edit({op:'place-bone',boneId,start,end})" @create="addBone" @rotate="rotate" @zoom="scale=$event" @error="error=$event">
          <div v-if="project && !meshDraft" class="toolstrip" role="toolbar" aria-label="画布工具">
            <button class="icon-button" :aria-pressed="tool==='select'" :aria-label="mode==='pose'?'旋转':'选择'" :title="mode==='pose'?'拖动骨身旋转 (V)':'选择 (V)'" @click="chooseTool('select')"><Icon :name="mode==='pose'?'reset':'select-cursor'"/></button>
            <button v-if="mode==='setup'" class="icon-button" :aria-pressed="tool==='bone'" aria-label="建骨" data-tip="建骨 (B) · Alt 偏移子骨" @click="chooseTool('bone')"><Icon name="bone"/></button>
            <button v-if="mode==='setup' && targetLayer && !anyPicking" class="icon-button" :disabled="model?.settings.get(targetLayer.layerId)?.locked" aria-label="编辑网格" data-tip="编辑网格" @click="startMesh"><Icon name="mesh"/></button>

            <button class="icon-button" aria-label="平移" title="平移 (H)，或按住空格拖动" :aria-pressed="tool==='pan'" @click="chooseTool('pan')"><Icon name="hand"/></button>

            <i class="separator"></i><button class="icon-button" aria-label="骨骼叠加" :disabled="anyPicking" :aria-pressed="bones" title="骨骼叠加" @click="bones=!bones"><Icon :name="bones?'eye':'eye-off'"/></button>
            <i class="separator"></i><button class="icon-button" aria-label="缩小" title="缩小" @click="stage?.magnify(.8)"><Icon name="zoom-out"/></button><output>{{scale}}%</output><button class="icon-button" aria-label="放大" title="放大" @click="stage?.magnify(1.25)"><Icon name="zoom-in"/></button><button class="icon-button" aria-label="适屏" title="适屏 (F)" @click="stage?.fit()"><Icon name="fit"/></button>
          </div>
          <div v-else-if="meshDraft" class="edit-capsules" role="toolbar" aria-label="网格工具">
            <div class="edit-capsule" v-if="!meshDraft.drawing || traceOpen">
              <button v-for="t in vertexTools" :key="t.mode" :aria-label="t.label" :data-tip="t.tip"
                :aria-pressed="vertexTool===t.mode" :disabled="traceOpen && !traceReady" @click="setVertexTool(t.mode)">
                <Icon :name="t.icon"/>
              </button>
            </div>
            <div class="edit-capsule" v-else><button aria-label="闭合轮廓" data-tip="闭合轮廓 (Enter)" :disabled="meshDraft.points.length<3" @click="closeContour"><Icon name="select-polygon"/></button></div>
            <div class="edit-capsule">
              <button aria-label="三角线" data-tip="显示三角线" :aria-pressed="triangles" @click="triangles=!triangles"><Icon name="mesh"/></button>
              <button aria-label="居中网格" data-tip="居中所选图层" @click="stage?.focusMesh()"><Icon name="fit"/></button>
            </div>
          </div>
        </Viewport>
        <div v-if="dropActive" class="drop-veil" aria-hidden="true">松开以载入作品/切片目录或 rig.json</div>
        <div v-if="pendingResume && !error && !busy && !diskRigChanged" class="notice resume-notice" role="status">
          <span>上次打开：{{ pendingResume.title }}</span>
          <button class="notice-action" @click="openRecentInStudio(pendingResume)">一键恢复</button>
          <button class="notice-dismiss" aria-label="忽略恢复提示" @click="pendingResume = null">×</button>
        </div>
        <div v-if="diskRigChanged && !error && !busy" class="notice resume-notice" role="status">
          <span>目录中的 rig.json 已在外部更新</span>
          <button class="notice-action" @click="reloadDiskRig(false)">重新载入</button>
          <button class="notice-dismiss" aria-label="忽略更新提示" @click="diskRigChanged = false">×</button>
        </div>
        <div v-if="busy" class="notice" role="status">正在打开企划…</div>
        <div v-else-if="syncToast && !error && !diskRigChanged" class="notice sync-toast" role="status">{{ syncToast }}</div>
        <div v-if="error && !pickingBones" class="notice problem" role="alert"><span>{{error}}</span><button aria-label="关闭提示" @click="clearNotice">×</button></div>
      </section>
      <aside v-if="project && model && pose" v-show="side" class="hierarchy" aria-label="大纲树">
        <Hierarchy :inert="!!meshDraft" :picking="anyPicking" :eligible="eligible" :picked="anyPicking ? pickPreview : []" :key="projectKey"
          :project="project" :model="model" :pose="pose" :selection="selected" :hovered="hoveredBone" :mode="mode" @select="select" @hover="id=>hoveredBone=id"
          @rename-bone="focusRenameBone" @reorder="layers=>edit({op:'draw-order',layers})" @edit-mesh="editMeshLayer"
          @lock="(layerId,locked)=>edit({op:'set-layer',layerId,locked})" @visibility="(layerId,visible)=>edit({op:'set-layer',layerId,visible})"/>
      </aside>
      <aside class="inspector" aria-label="属性检查器">
        <MeshInspector v-if="meshDraft && canvasDraft && targetLayer && project"
        :name="targetLayer.name" :layer-id="targetLayer.layerId" :width="targetLayer.rect[2]" :height="targetLayer.rect[3]"
        :draft="canvasDraft" :active="activeVertex" :snapping="snapping" @snap="snapping=$event" @position="setVertexPosition" @preview-position="point=>vertexPreview=point" :drawing="meshDraft.drawing" :tracing="traceOpen" :ready="traceReady" :has-saved-mesh="hasSavedMesh" :alpha="traceSource" :options="traceOptions"
        @trace="openTrace" @back="traceOpen=false" @pending="traceReady=false" @preview="previewTrace" @settings="traceOptions=$event"
        @adjust="finishTrace" @new-contour="drawContour" @apply="applyMesh" @cancel="cancelMesh" @clear="clearMesh"/>
        <BoneBinding v-else-if="targetLayer && model" :key="projectKey + ':' + targetLayer.layerId" :layer="targetLayer"
          :icon="pose?.parts.find(part=>part.layerId===targetLayer?.layerId)?.geometry ? 'mesh' : selected?.type==='attachment' ? 'region-attach' : 'layer-slot'"
          :model="model" :readonly="mode!=='setup'" :binding="pickedBinding" :bound="boundBones" :picking="pickingBones"
          :draft="chainPick" :first="firstPick" :last="lastPick" :endpoint="endpoint" :direct="directSlot" :eligible="eligible"
          :focused="focusedBone" :hovered="hoveredBone" :issue="pickIssue || (pickingBones ? error : '')" :changed="bindingChanged"
          :can-auto-mesh="canAutoMeshLayer"
          @begin="beginBind" @cancel="cancelBind" @soften="soften" @preview-width="v=>softnessPreview=v"
          @apply="confirmBind" @clear="clearBinding" @endpoint="setEndpoint" @auto-mesh="autoMeshSelectedLayer"
          @pick="id=>select({type:'bone',id})" @locate="focusBone" @hover="id=>hoveredBone=id"/>
        <BoneInspector v-else-if="pickedBone && model" ref="boneInspector"
          :bone="pickedBone" :model="model" :mode="mode" :pose-transform="pickedPoseTransform"
          :picking-parent="pickingParent" :can-pick-parent="parentEligible.size > 0" :delete-blocker="deleteBlocker"
          @rename="renameBone" @edit-prop="setBoneProp" @pose-prop="setBonePoseProp" @select-bone="id=>select({type:'bone',id})" @hover-bone="id=>hoveredBone=id"
          @begin-pick-parent="beginParentPick" @cancel-pick-parent="cancelBind" @clear-parent="reparentBone(null)" @remove="removeBone"
          @reset-pose="scrubPose=undefined;boneTransforms={};parameters={};clearNotice()"/>
        <p v-else class="empty">选择图层、网格或骨骼</p>
        <div v-if="mode==='pose' && meshParameter" class="props-body">
          <ScrubNumber :label="meshParameter.id" :title="meshParameter.meaning" :value="parameters[meshParameter.id] ?? meshParameter.default"
            :unit="meshParameter.unit" @preview="v=>setMeshParamValue(v,false)" @commit="v=>setMeshParamValue(v,true)"/>
        </div>
      </aside>
    </div>
    <input ref="folder" hidden type="file" webkitdirectory multiple @change="openFiles($event,'folder')"><input ref="rigFile" hidden type="file" accept=".json" @change="openFiles($event,'rig')">
  </main>
</template>
