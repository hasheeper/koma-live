<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  label: string; value: number; unit?: string; min?: number; max?: number; step?: number; integer?:boolean; disabled?: boolean
}>(), {step: 0.5})
const emit = defineEmits<{ commit:[value:number]; preview:[value?:number] }>()
const field = ref<HTMLInputElement>(), control = ref<HTMLButtonElement>()
const editing = ref(false), draft = ref<number>()
const display = computed(() => Number((draft.value ?? props.value).toFixed(5)))
let gesture: {id:number; start:number; last:number; value:number; moved:boolean} | undefined

function clamp(n:number) {
  return Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n))
}
function normalized(n:number) { return props.integer ? Math.round(n) : Number(n.toFixed(6)) }
function endGesture() {
  gesture = undefined
  draft.value = undefined
  emit('preview', undefined)
}
function cancel() {
  const wasEditing = editing.value
  editing.value = false
  endGesture()
  if (wasEditing) nextTick(() => control.value?.focus({preventScroll:true}))
}
function typeValue() {
  if (props.disabled) return
  editing.value = true
  nextTick(() => {field.value?.focus({preventScroll:true}); field.value?.select()})
}
function submit() {
  if (!editing.value) return
  const n = field.value?.valueAsNumber
  if (n !== undefined && Number.isFinite(n) && n===clamp(n) && normalized(n)!==props.value) emit('commit',normalized(n))
  editing.value = false
}
function down(e:PointerEvent) {
  if (props.disabled || editing.value || gesture || e.button!==0 || !e.isPrimary) return
  e.preventDefault()
  control.value?.focus({preventScroll:true})
  gesture = {id:e.pointerId,start:e.clientX,last:e.clientX,value:props.value,moved:false}
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
}
function move(e:PointerEvent) {
  const g = gesture
  if (!g || e.pointerId!==g.id) return
  if (!g.moved && Math.abs(e.clientX-g.start)<3) return
  g.moved = true
  g.value = clamp(g.value + (e.clientX-g.last)*props.step*(e.shiftKey ? 0.1 : 1))
  g.last = e.clientX
  draft.value = normalized(g.value)
  emit('preview', draft.value)
}
function up(e:PointerEvent) {
  if (!gesture || e.pointerId!==gesture.id) return
  const {moved} = gesture, value = draft.value
  endGesture()
  if (!moved) typeValue()
  else if (value!==undefined && value!==props.value) emit('commit',value)
}
function key(e:KeyboardEvent) {
  if (e.key==='Escape') {e.preventDefault(); e.stopPropagation(); cancel(); return}
  if (editing.value || props.disabled) return
  if (e.key==='Enter' || e.key===' ') {e.preventDefault();typeValue()}
  else if (e.key==='ArrowRight' || e.key==='ArrowLeft' || e.key==='ArrowUp' || e.key==='ArrowDown') {
    e.preventDefault()
    const sign = e.key==='ArrowRight' || e.key==='ArrowUp' ? 1 : -1
    const next = normalized(clamp(props.value+sign*props.step*(e.shiftKey && !props.integer ? 0.1 : 1)))
    if (next!==props.value) emit('commit',next)
  }
}
watch(() => [props.value,props.disabled], cancel)
onMounted(() => window.addEventListener('blur', cancel))
onBeforeUnmount(() => {window.removeEventListener('blur', cancel); if (gesture) endGesture()})
</script>
<template>
  <div class="property-row scrub" :class="{disabled,dragging:draft!==undefined}" @pointerdown="down" @pointermove="move" @pointerup="up"
    @pointercancel="endGesture" @lostpointercapture="gesture && endGesture()" @keydown="key">
    <span class="property-name">{{label}}</span>
    <div class="number-well" :title="label+' · 左右拖调，Shift 微调，单击输入'">
      <input v-if="editing" ref="field" :aria-label="label" type="number" step="any" :min="min" :max="max" :value="value"
        @keydown.enter.prevent.stop="submit();nextTick(()=>control?.focus())" @blur="submit">
      <button v-else ref="control" role="spinbutton" :aria-label="label" :aria-valuenow="display" :aria-valuemin="min" :aria-valuemax="max"
        :disabled="disabled" @click="(e:MouseEvent)=>{if(e.detail===0)typeValue()}">{{display}}</button>
      <span v-if="unit" class="unit">{{unit}}</span>
    </div>
  </div>
</template>
