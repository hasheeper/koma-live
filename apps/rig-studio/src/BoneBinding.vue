<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Bone, Rig, SliceManifest } from '@koma-rig/rig-core'
import Icon from './Icon.vue'
import ScrubNumber from './ScrubNumber.vue'
import type { Endpoint } from './binding-selection'

const props = defineProps<{
  icon: string
  readonly: boolean
  direct?: Endpoint
  layer: SliceManifest['layers'][number]
  model: Rig
  binding?: Rig['bindings'][number]
  bound: string[]
  picking: boolean
  draft: string[]
  first?: string
  last?: string
  endpoint: Endpoint
  hovered?: string
  eligible?: Set<string>
  focused?: string
  issue: string
  changed: boolean
  canAutoMesh?: boolean
}>()
const emit = defineEmits<{
  previewWidth:[width?:number]; begin: [slot?:Endpoint]; cancel: []; apply: []; clear: []; endpoint: [which: Endpoint]
  soften: [width: number]; pick: [id: string]; locate: [id: string]; hover: [id?: string]; autoMesh: []
}>()

const expanded = ref(false)
const locked = computed(() => props.readonly || !!props.model.settings.get(props.layer.layerId)?.locked)
const bones = computed(() => props.model.skeleton.byId)
const name = (id: string) => bones.value.get(id)?.name ?? id
const repeatedNames = computed(() => {
  const seen = new Set<string>(), repeated = new Set<string>()
  for (const bone of bones.value.values()) {
    const label = name(bone.boneId)
    if (seen.has(label)) repeated.add(label)
    seen.add(label)
  }
  return repeated
})
const describe = (id: string) => name(id) === id ? id : name(id) + ' · ' + id
const draftSet = computed(() => new Set(props.draft))
const query = ref(''), onlySelected = ref(false)
const list = ref<HTMLElement>(), search = ref<HTMLInputElement>()

// Walk siblings together. Source files may store children before their parents.
const candidates = computed(() => {
  const children = new Map<string | null, Bone[]>()
  for (const bone of bones.value.values()) {
    const parent = bone.parentBoneId ?? null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(bone)
  }
  const rows: string[] = []
  function visit(parent: string | null) {
    for (const bone of children.get(parent) ?? []) {
      rows.push(bone.boneId)
      visit(bone.boneId)
    }
  }
  visit(null)
  return rows
})
const hasSearch = computed(() => (props.picking || expanded.value) && (props.picking ? bones.value.size : props.bound.length) > 6)
const rows = computed(() => {
  const ids = props.picking ? props.draft : props.bound
  const source = props.picking && !onlySelected.value ? candidates.value : ids
  const term = query.value.trim().toLowerCase()
  return term ? source.filter(id => describe(id).toLowerCase().includes(term)) : source
})
function unavailable(id: string) { return !!props.eligible && !props.eligible.has(id) }
function choose(id: string) {
  if (props.picking) emit('pick', id)
  else emit('locate', id)
}
function navigate(event: KeyboardEvent) {
  if (!list.value || event.altKey || event.metaKey || event.ctrlKey) return
  const buttons = Array.from(list.value.querySelectorAll<HTMLButtonElement>('button'))
  const from = buttons.indexOf(event.target as HTMLButtonElement)
  if (from < 0 && event.key !== 'ArrowDown') return
  const steps: Record<string,number> = {ArrowDown:1, ArrowUp:-1}
  let step = steps[event.key]
  let next = from
  if (event.key === 'Home' || from < 0) { next = -1; step = 1 }
  else if (event.key === 'End') { next = buttons.length; step = -1 }
  if (!step) return
  event.preventDefault()
  for (next += step; next >= 0 && next < buttons.length; next += step) {
    if (!buttons[next]!.disabled) { buttons[next]!.focus(); return }
  }
}
watch(() => props.picking, async active => {
  query.value = ''
  onlySelected.value = false
  await nextTick()
  if (active && matchMedia('(pointer:fine)').matches) search.value?.focus({preventScroll:true})
})
watch(hasSearch, visible => { if (!visible) query.value = '' })
watch([query, onlySelected], () => { if (list.value) list.value.scrollTop = 0 })


watch(() => props.focused, async id => {
  if (!id) return
  await nextTick()
  list.value?.querySelector<HTMLElement>('[data-bone="'+CSS.escape(id)+'"]')?.scrollIntoView({block:'nearest'})
})

const jointLengths = computed(() => {
  return props.bound.map((id, i) => {
    const frame = props.model.skeleton.rest.get(id)!
    const next = props.bound[i+1]
    const end = next ? props.model.skeleton.rest.get(next)!.start : frame.end
    return Math.hypot(end[0]-frame.start[0], end[1]-frame.start[1])
  })
})
const width = computed(() => props.binding?.jointSoftnessPx ?? Math.min(...jointLengths.value) / 4)
const slots = computed(() => {
  const ids = props.picking ? props.draft : props.bound
  return [
    {which:'start' as const, label:'起骨', id:ids[0]},
    {which:'end' as const, label:'末骨', id:ids.length>1 ? ids.at(-1) : undefined},
  ]
})
function pickSlot(which: Endpoint) {
  if (props.direct===which) emit('cancel')
  else emit('begin',which)
}
</script>

<template>
  <section class="binding-panel" :aria-label="picking ? '编辑骨骼绑定' : '骨骼绑定'">
    <div class="object-head" :title="layer.name+' ('+layer.layerId+')'"><Icon :name="icon"/><strong>{{layer.name}}</strong><code>{{layer.layerId}}</code></div>
    <div class="props-body">
      <div class="section-heading"><strong>骨骼绑定</strong><button v-if="!picking && !readonly" class="heading-action" aria-label="重选整链" :disabled="locked || !bones.size" title="重选整条骨链或解绑" @click="emit('begin')"><Icon name="branch"/></button></div>
      <div v-for="slot in slots" :key="slot.which" class="property-row">
        <span class="property-name">{{slot.label}}</span>
        <div class="bone-slot" :class="{armed:picking && endpoint===slot.which, unassigned:!slot.id}">
          <button class="slot-value" :aria-label="slot.id ? '定位'+slot.label+' '+describe(slot.id) : '指定'+slot.label" :disabled="!slot.id && (locked || !bones.size || (slot.which==='end' && !first && !bound.length))" :title="slot.id ? describe(slot.id) : '拾取'+slot.label"
            @pointerenter="emit('hover',slot.id)" @pointerleave="emit('hover',undefined)"
            @click="slot.id ? emit('locate',slot.id) : picking && !direct ? emit('endpoint',slot.which) : pickSlot(slot.which)">
            <Icon name="bone"/><span>{{slot.id ? name(slot.id) : '未指定'}}</span><code v-if="slot.id && name(slot.id)!==slot.id && repeatedNames.has(name(slot.id))">{{slot.id}}</code>
          </button>
          <button v-if="!readonly" class="pick-button" :aria-label="'拾取'+slot.label" :title="'从画布、树或列表拾取'+slot.label"
            :aria-pressed="picking && endpoint===slot.which" :disabled="locked || !bones.size || (slot.which==='end' && !first && !bound.length)"
            @click="picking && !direct ? emit('endpoint',slot.which) : pickSlot(slot.which)"><Icon name="pick"/></button>
        </div>
      </div>
      <div v-if="!picking && bound.length>2" class="property-row">
        <span class="property-name">完整骨链</span>
        <button class="disclose" :aria-expanded="expanded" @click="expanded=!expanded"><span>{{bound.length}} 根骨骼</span><Icon :name="expanded?'up':'down'"/></button>
      </div>
      <ScrubNumber v-if="!picking && bound.length>1" label="关节柔化" unit="px" :min="Math.min(width,0.01)" :disabled="locked" :value="width"
        @preview="v=>emit('previewWidth',v)" @commit="v=>emit('soften',v)"/>
      <div v-if="!picking && !readonly && canAutoMesh" class="chain-mesh-cta">
        <button :disabled="locked" title="按骨链安全防翻面参数一键生成贴合轮廓网格" @click="emit('autoMesh')">
          <Icon name="mesh"/><span>生成骨链轮廓网格</span>
        </button>
      </div>
    </div>
    <template v-if="picking || (expanded && bound.length>2)">
      <div v-if="picking" class="pick-status" role="status"><span>{{direct ? '拾取'+(direct==='start'?'起骨':'末骨') : endpoint==='start' ? '选择新链起点' : '选择同链终点'}}</span><button @click="emit('cancel')" title="取消拾取">Esc</button></div>
      <div v-if="picking && !direct" class="list-filters">
        <button :aria-pressed="!onlySelected" @click="onlySelected=false">全部 {{bones.size}}</button>
        <button :aria-pressed="onlySelected" @click="onlySelected=true">已选 {{draft.length}}</button>
      </div>
      <input v-if="hasSearch" ref="search" class="bone-search" type="search" v-model="query" placeholder="搜索骨名或 ID" aria-label="搜索骨骼名称或 ID" @keydown="navigate">
      <div ref="list" class="bone-grid" role="group" :aria-label="picking?'候选骨骼':'完整骨链'" @keydown="navigate" @pointerleave="emit('hover',undefined)" @focusout="emit('hover',undefined)">
        <button v-for="id in rows" :key="id" :data-bone="id" class="bone-row" :class="{active:focused===id || hovered===id, member:picking && draftSet.has(id)}"
          :disabled="picking && unavailable(id)" :aria-label="(picking?'选取 ':'定位 ')+describe(id)" :title="describe(id)"
          @focus="emit('hover',id)" @pointerenter="emit('hover',unavailable(id) ? undefined : id)" @click="choose(id)">
          <Icon name="bone"/><span>{{name(id)}}</span><code v-if="name(id)!==id">{{id}}</code>
        </button>
        <p v-if="!rows.length" class="empty">{{query?'没有匹配的骨骼':'尚未选择骨骼'}}</p>
      </div>
      <p v-if="issue" role="alert" class="pick-issue">{{issue}}</p>
      <div v-if="picking && !direct" class="binding-actions">
        <button :disabled="!draft.length" @click="onlySelected=false;emit('clear')">清空选择</button>
        <button @click="emit('cancel')">取消</button><button :disabled="!changed || !!issue" @click="emit('apply')">{{!draft.length && bound.length ? '应用解绑' : '应用绑定'}}</button>
      </div>
    </template>
  </section>
</template>
