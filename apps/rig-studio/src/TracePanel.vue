<script setup lang="ts">
import Icon from './Icon.vue'
import ScrubNumber from './ScrubNumber.vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { defaultTrace, suggestAlphaThreshold, type AttachmentMesh, type TraceOptions } from '@koma-rig/rig-core'

const props = defineProps<{alpha:Uint8Array; width:number; height:number; options?:TraceOptions}>()
const emit = defineEmits<{preview:[mesh:AttachmentMesh|null]; pending:[]; settings:[options:TraceOptions]; close:[]}>()
const suggested = suggestAlphaThreshold(props.alpha)
const settings = reactive<TraceOptions>(props.options ?? {...defaultTrace, alphaThreshold:suggested})
const trial = ref<{key:keyof TraceOptions; value:number}>()
const effective = computed(() => trial.value ? {...settings,[trial.value.key]:trial.value.value} : {...settings})
const controls: {key:keyof TraceOptions; name:string; max:number; hint:string}[] = [
  {key:'detail', name:'细节', max:100, hint:'保留更多轮廓转折，增加顶点'},
  {key:'concavity', name:'凹度', max:100, hint:'提高凹口的保留优先级，0 使用凸轮廓'},
  {key:'refinement', name:'精致度', max:100, hint:'细化边缘采样和转折误差容限'},
  {key:'alphaThreshold', name:'Alpha 阈值', max:255, hint:'只追踪不透明度达到此值的像素（0–255）'},
  {key:'padding', name:'填充', max:32, hint:'向轮廓外扩的原图像素数'},
]
const pending = ref(true), error = ref('')
let worker: Worker | undefined, revision=0, timer: ReturnType<typeof setTimeout> | undefined
function update() {
  if (!worker) return
  const id = ++revision
  emit('pending'); emit('settings',{...settings})
  pending.value=true
  error.value=''
  clearTimeout(timer)
  timer=setTimeout(()=>worker?.postMessage({id, options:{...effective.value}}),50)
}
function fail(message:string) { error.value=message; pending.value=false; emit('preview',null) }
onMounted(()=>{
  worker=new Worker(new URL('./trace.worker.ts',import.meta.url),{type:'module'})
  worker.onerror=e=>fail(e.message || '描绘失败')
  worker.onmessage=({data}:MessageEvent<{id:number; mesh?:AttachmentMesh; error?:string}>)=>{
    if (data.id!==revision) return
    if (!data.mesh) { fail(data.error ?? '描绘失败'); return }
    pending.value=false; emit('preview',data.mesh)
  }
  worker.postMessage({source:{alpha:props.alpha,width:props.width,height:props.height}})
  update()
})
watch(effective,update,{flush:'sync'})
onBeforeUnmount(()=>{clearTimeout(timer);worker?.terminate()})
</script>
<template>
  <section class="props-body trace-panel" aria-label="描绘参数" :aria-busy="pending">
    <div class="section-heading">
      <strong>自动描绘</strong>
      <span class="heading-meta">
        <button class="heading-action" aria-label="自动阈值" title="按当前图层透明度估算 Alpha 阈值" @click="settings.alphaThreshold=suggested"><Icon name="alpha"/></button>
        <button class="heading-action" aria-label="收起自动描绘" title="收起自动描绘，返回手修网格 (Esc)" @click="emit('close')"><Icon name="close"/></button>
      </span>
    </div>
    <ScrubNumber v-for="c in controls" :key="c.key" :label="c.name" :title="c.hint" :value="settings[c.key]" :min="0" :max="c.max" :step="1" integer
      @preview="v=>trial=v===undefined ? undefined : {key:c.key,value:v}" @commit="v=>settings[c.key]=v"/>
    <p v-if="error" role="status">{{error}}</p>
    <slot />
  </section>
</template>
