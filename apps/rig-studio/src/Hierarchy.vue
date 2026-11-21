<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Pose, Rig } from '@koma-rig/rig-core'
import type { Mode, Project, Selection } from './project'
import { canNudgeDrawOrder, nudgeDrawOrder, reorderDrawOrder } from './draw-order'
import Icon from './Icon.vue'

const props = defineProps<{ project: Project; model: Rig; pose: Pose; selection: Selection; hovered?: string; mode: Mode; eligible?: Set<string>; picking: boolean; picked: string[] }>()
const emit = defineEmits<{ select: [item: Selection]; visibility: [id: string, visible: boolean]; lock: [id:string, locked:boolean]; hover: [id?:string]; renameBone: [id:string]; reorder: [layers:string[]]; editMesh: [layerId:string] }>()
const list = ref<HTMLElement>(), input = ref<HTMLInputElement>()
const view = ref<'tree' | 'order'>('tree'), search = ref(false), query = ref('')
const expanded = ref(new Set(['section:layers', 'section:bones']))
const layerById = computed(() => new Map(props.project.manifest.layers.map(layer => [layer.layerId, layer])))
const draftSet = computed(() => new Set(props.picked))
const bindingById = computed(() => new Map(props.model.bindings.map(binding => [binding.layerId, binding])))
type Kind = Exclude<Selection, null>['type'] | 'section'
interface Node {
  kind: Kind
  id: string
  name: string
  icon: string
  children?: Node[]
  locked?: boolean
  hidden?: boolean
}
function key(node: Node) { return node.kind + ':' + node.id }
function isChosen(node: Node) { return props.selection?.type === node.kind && props.selection.id === node.id }

const graph = computed<Node[]>(() => {
  const layers = [...props.pose.parts].reverse().map((part): Node => {
    const layer = layerById.value.get(part.layerId)!
    const deformer = bindingById.value.get(layer.layerId)?.deformer
    const name = bindingById.value.get(layer.layerId)?.mesh ? '轮廓网格' : bindingById.value.get(layer.layerId)?.boneChain ? '骨链网格' : deformer?.kind === 'ffd' ? '晶格网格' : deformer?.kind === 'ribbon' ? '条带网格' : '图像'
    const locked = !!props.model.settings.get(layer.layerId)?.locked
    const attachment: Node = { kind: 'attachment', id: layer.layerId, name, icon: part.geometry ? 'mesh' : 'region-attach', hidden: !part.visible, locked }
    return { kind: 'layer', id: layer.layerId, name: layer.name, icon: 'layer-slot', hidden: !part.visible, locked, children: [attachment] }
  })
  if (view.value === 'order') return layers.map(layer => ({ ...layer, children: undefined }))

  const bones = props.model.skeleton.byId
  const roots: Node[] = []
  const nodes = new Map([...bones.values()].map(b => [b.boneId, {
    kind: 'bone', id: b.boneId, name: b.name ?? b.boneId, icon: b.length ? 'bone' : 'bone-point', children: [],
  } as Node]))
  for (const b of bones.values()) {
    const siblings = b.parentBoneId ? nodes.get(b.parentBoneId)!.children! : roots
    siblings.push(nodes.get(b.boneId)!)
  }
  return [
    { kind: 'section', id: 'layers', name: '图层', icon: 'layers', children: layers },
    { kind: 'section', id: 'bones', name: '骨骼', icon: 'branch', children: roots },
  ]
})

const rows = computed(() => {
  const term = query.value.trim().toLowerCase()
  function visit(node: Node, depth: number, showBranch: boolean): { node: Node; depth: number }[] {
    const match = (node.name + ' ' + node.id).toLowerCase().includes(term)
    const show = !term || showBranch || match
    const open = term || expanded.value.has(key(node))
    const children = open ? node.children?.flatMap(child => visit(child, depth + 1, !!term && show)) ?? [] : []
    return show || children.length ? [{ node, depth }, ...children] : []
  }
  // Section headers are group labels, not tree nodes: their children start flush at depth 0.
  const offset = view.value === 'tree' ? 1 : 0
  return graph.value.flatMap(node => visit(node, 0, false))
    .map(row => ({ ...row, depth: row.node.kind === 'section' ? 0 : Math.max(0, row.depth - offset) }))
})
function toggle(node: Node) {
  const k = key(node)
  if (expanded.value.has(k)) expanded.value.delete(k)
  else expanded.value.add(k)
}
function select(node: Node) {
  if (node.kind === 'section') { toggle(node); return }
  emit('select', { type: node.kind, id: node.id })
}
function reveal(s: Selection) {
  if (!s) return
  query.value = ''
  if (s.type === 'bone') {
    view.value = 'tree'
    expanded.value.add('section:bones')
    let parent = props.model.skeleton.byId.get(s.id)?.parentBoneId
    while (parent) {
      expanded.value.add('bone:' + parent)
      parent = props.model.skeleton.byId.get(parent)?.parentBoneId
    }
  } else {
    expanded.value.add('section:layers')
    expanded.value.add('layer:' + s.id)
    if (s.type === 'attachment') view.value = 'tree'
  }
  nextTick(() => {
    const row = list.value?.querySelector<HTMLElement>('.chosen')
    if (!row || !list.value) return
    const item = row.getBoundingClientRect(), panel = list.value.getBoundingClientRect()
    if (item.bottom > panel.bottom) list.value.scrollTop += item.bottom - panel.bottom
    else if (item.top < panel.top) list.value.scrollTop += item.top - panel.top
  })
}
for (const b of props.model.skeleton.byId.values()) {
  if (!b.parentBoneId) expanded.value.add('bone:' + b.boneId)
}
watch(() => props.selection, reveal, { immediate: true })
function switchView(next: 'tree' | 'order') {
  view.value = next
  if (next === 'order' && props.selection?.type === 'attachment') emit('select', { type: 'layer', id: props.selection.id })
}
function find() {
  search.value = !search.value
  query.value = ''
  if (search.value) nextTick(() => input.value?.focus())
}

const backToFront = computed(() => props.pose.parts.map(p => p.layerId))
const canReorder = computed(() => view.value === 'order' && props.mode === 'setup' && !props.picking && !query.value.trim())
const dragId = ref<string>()
const dropTarget = ref<{ id: string; position: 'before' | 'after' }>()

function clearDrag() {
  dragId.value = undefined
  dropTarget.value = undefined
}
function onDragStart(id: string, event: DragEvent) {
  if (!canReorder.value) return
  dragId.value = id
  dropTarget.value = undefined
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}
function onDragOver(id: string, event: DragEvent) {
  if (!canReorder.value || !dragId.value) return
  const row = event.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const position: 'before' | 'after' = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  const valid = !!reorderDrawOrder(backToFront.value, props.project.manifest, dragId.value, id, position)
  if (!valid) {
    if (dropTarget.value?.id === id) dropTarget.value = undefined
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropTarget.value = { id, position }
}
function onDrop(id: string, event: DragEvent) {
  if (!canReorder.value || !dragId.value) { clearDrag(); return }
  const position = dropTarget.value?.id === id ? dropTarget.value.position : 'before'
  const next = reorderDrawOrder(backToFront.value, props.project.manifest, dragId.value, id, position)
  clearDrag()
  if (next) {
    event.preventDefault()
    emit('reorder', next)
  }
}
function nudge(id: string, direction: 'up' | 'down') {
  if (!canReorder.value) return
  const next = nudgeDrawOrder(backToFront.value, props.project.manifest, id, direction)
  if (next) emit('reorder', next)
}
function nudgeBounds(id: string) {
  return canNudgeDrawOrder(backToFront.value, props.project.manifest, id)
}
function onDoubleClick(node: Node) {
  if (props.mode !== 'setup' || props.picking) return
  if (node.kind === 'bone') emit('renameBone', node.id)
  else if (node.kind === 'attachment' && !node.locked) emit('editMesh', node.id)
}
watch(canReorder, ok => { if (!ok) clearDrag() })
</script>

<template>
  <section class="project-tree" aria-label="对象工作区">
    <div class="tree-tabs">
      <div class="tree-views">
        <button :aria-pressed="view==='tree'" @click="switchView('tree')">层级树</button>
        <button :aria-pressed="view==='order'" @click="switchView('order')">绘制顺序</button>
      </div>
      <button class="icon-button find" aria-label="查找对象" title="查找对象" :aria-pressed="search" @click="find"><Icon name="search"/></button>
    </div>
    <input v-if="search" ref="input" v-model="query" class="tree-search" type="search"
      placeholder="查找图层、网格或骨骼" aria-label="查找对象名称" @keydown.esc="find">
    <div class="tree-header" aria-hidden="true">
      <span class="gutter-head" title="显隐"><Icon name="eye"/></span>
      <span class="gutter-head" title="锁定"><Icon name="lock"/></span>
      <span class="tree-col-title">{{ view === 'tree' ? '对象层级' : '绘制顺序' }}</span>
    </div>
    <div ref="list" class="tree-body" @dragleave.self="dropTarget=undefined">
      <div v-for="{node,depth} in rows" :key="key(node)" class="tree-row" :data-kind="node.kind"
        :draggable="canReorder && node.kind==='layer'"
        :class="{chosen:isChosen(node) || (picking && node.kind==='bone' && draftSet.has(node.id)), hovered:node.kind==='bone' && node.id===hovered && !isChosen(node), muted:node.hidden, reorderable:canReorder && node.kind==='layer', dragging:dragId===node.id, 'drop-before':dropTarget?.id===node.id && dropTarget.position==='before', 'drop-after':dropTarget?.id===node.id && dropTarget.position==='after'}"
        :style="{'--depth':Math.min(5,depth)}"
        @dragstart="node.kind==='layer' && onDragStart(node.id, $event)"
        @dragover="node.kind==='layer' && onDragOver(node.id, $event)"
        @drop="node.kind==='layer' && onDrop(node.id, $event)"
        @dragend="clearDrag">
        <div class="tree-states">
          <template v-if="node.kind==='layer' || node.kind==='attachment'">
            <button class="state-cell vis-cell" :class="{off:node.hidden, on:!node.hidden}" :disabled="picking || mode!=='setup'" :aria-pressed="!node.hidden"
              :aria-label="(node.hidden?'显示':'隐藏')+(layerById.get(node.id)?.name ?? node.name)+(node.kind==='attachment'?'所属图层':'')"
              :title="node.hidden?'显示图层':'隐藏图层'" @click="emit('visibility',node.id,!!node.hidden)">
              <span class="state-dot" aria-hidden="true"></span>
            </button>
            <button class="state-cell lock-cell" :class="{flag:node.locked}" :disabled="picking || mode!=='setup'" :aria-pressed="!!node.locked"
              :aria-label="(node.locked?'解锁':'锁定')+(layerById.get(node.id)?.name ?? node.name)+(node.kind==='attachment'?'所属图层':'')"
              :title="node.locked?'解锁图层':'锁定图层'" @click="emit('lock',node.id,!node.locked)">
              <Icon v-if="node.locked" name="lock"/>
              <span v-else class="state-dot subtle" aria-hidden="true"></span>
            </button>
          </template>
          <template v-else>
            <span class="state-cell empty-cell" aria-hidden="true"></span>
            <span class="state-cell empty-cell" aria-hidden="true"></span>
          </template>
        </div>
        <div class="tree-content">
          <span class="tree-indent"></span>
          <button v-if="node.children?.length && !query" class="twist" :aria-expanded="expanded.has(key(node))"
            :aria-label="(expanded.has(key(node))?'收起':'展开')+node.name" @click="toggle(node)">
            <svg viewBox="0 0 8 8" aria-hidden="true" :class="{closed:!expanded.has(key(node))}"><path d="M1.2 2.2h5.6L4 6.2Z"/></svg>
          </button><span v-else class="indent"></span>
          <button class="node" :aria-label="node.kind==='attachment' ? layerById.get(node.id)?.name+'的'+node.name : node.name"
            :title="node.name + (node.kind==='bone' ? ' · '+node.id : canReorder && node.kind==='layer' ? ' · 拖动调整绘制顺序' : '')" :disabled="picking && node.kind!=='section' && (node.kind!=='bone' || (!!eligible && !eligible.has(node.id)))" @pointerenter="emit('hover', node.kind==='bone' ? node.id : undefined)" @pointerleave="emit('hover',undefined)" :aria-current="isChosen(node)" @click="select(node)" @dblclick="onDoubleClick(node)">
            <Icon :name="node.icon"/><span>{{node.name}}</span>
          </button>
          <span v-if="canReorder && node.kind==='layer'" class="order-actions">
            <button aria-label="上移一层" title="上移一层（更靠前）" :disabled="!nudgeBounds(node.id).up" @click.stop="nudge(node.id,'up')"><Icon name="up"/></button>
            <button aria-label="下移一层" title="下移一层（更靠后）" :disabled="!nudgeBounds(node.id).down" @click.stop="nudge(node.id,'down')"><Icon name="down"/></button>
          </span>
        </div>
      </div>
      <p v-if="!rows.length" class="empty">没有匹配对象</p>
    </div>
  </section>
</template>
