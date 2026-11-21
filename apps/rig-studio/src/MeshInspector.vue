<script setup lang="ts">
import { computed } from 'vue'
import type { AttachmentMesh, TraceOptions, Point } from '@koma-rig/rig-core'
import Icon from './Icon.vue'
import TracePanel from './TracePanel.vue'
import ScrubNumber from './ScrubNumber.vue'

const props=defineProps<{
  name:string; layerId:string; width:number; height:number; alpha:Uint8Array|undefined
  active:number|null; snapping:boolean; draft:AttachmentMesh; drawing:boolean; tracing:boolean; ready:boolean; hasSavedMesh:boolean; options?:TraceOptions
}>()
const emit=defineEmits<{
  snap:[enabled:boolean]; previewPosition:[point?:Point]; position:[point:Point]; trace:[]; back:[]; newContour:[]; apply:[]; cancel:[]; clear:[]; preview:[mesh:AttachmentMesh|null]; pending:[];
  settings:[options:TraceOptions]; adjust:[]
}>()
const canApply=computed(()=>props.draft.points.length>=3 && (!props.tracing || props.ready))
const point = computed(()=>props.active===null || props.tracing ? undefined : props.draft.points[props.active])
function coordinate(axis:0|1,value:number | undefined, preview=false) {
  if (value===undefined || !point.value) { if (preview) emit('previewPosition'); return }
  if (!preview && value===point.value[axis]) return
  const next:Point=[...point.value]
  next[axis]=value
  if (preview) emit('previewPosition',next)
  else emit('position',next)
}
</script>
<template>
  <section class="mesh-inspector" aria-label="网格托盘">
    <div class="object-head" :title="name+' ('+layerId+')'"><Icon name="mesh"/><strong>{{name}}</strong><code>{{layerId}}</code></div>
    <div class="mesh-scroll">
      <section class="props-body" aria-label="网格信息">
        <div class="section-heading">
          <strong>编辑网格</strong>
          <span class="heading-meta">
            <span class="vertex-count">{{draft.points.length}} 点</span>
            <button v-if="hasSavedMesh && !tracing" class="heading-action danger" aria-label="清除网格" title="清除自定义网格，还原为普通图像" @click="emit('clear')"><Icon name="trash"/></button>
          </span>
        </div>
        <div class="property-row"><span class="property-name">切片尺寸</span><div class="value-well"><output>{{width}} × {{height}}</output><span class="unit">px</span></div></div>
        <div v-if="!tracing" class="property-row">
          <span class="property-name">顶点吸附</span>
          <button class="toggle-well" role="switch" :aria-checked="snapping" title="拖动或加点时对齐边界与邻点（按住 Alt 临时关闭）"
            @click="emit('snap', !snapping)">
            <span class="toggle-state"><span class="toggle-dot" aria-hidden="true"></span>{{ snapping ? '开启' : '关闭' }}</span>
            <kbd>Alt</kbd>
          </button>
        </div>
        <div v-if="!tracing" class="inspector-actions">
          <button @click="emit('trace')"><Icon name="dt-wand"/>自动描绘</button>
          <button class="icon-only" aria-label="新建轮廓" title="重绘轮廓（从空轮廓开始，可撤销）" @click="emit('newContour')"><Icon name="select-polygon"/></button>
        </div>
      </section>

      <section v-if="point" class="props-body" aria-label="所选顶点">
        <div class="section-heading"><strong>顶点 {{active!+1}}</strong></div>
        <ScrubNumber v-for="axis in ([0,1] as const)" :key="axis" :label="axis?'顶点 Y':'顶点 X'" :value="point[axis]" unit="px"
          :min="0" :max="axis?height:width" @preview="v=>coordinate(axis,v,true)" @commit="v=>coordinate(axis,v)"/>
      </section>

      <TracePanel v-if="tracing && alpha" :alpha="alpha" :width="width" :height="height" :options="options"
        @preview="emit('preview',$event)" @pending="emit('pending')" @settings="emit('settings',$event)" @close="emit('back')">
        <button class="return-edit" :disabled="!ready" @click="emit('adjust')"><Icon name="select-cursor"/>采纳并调整顶点</button>
      </TracePanel>
    </div>
    <footer>
      <button aria-label="取消" @click="emit('cancel')">取消</button>
      <button class="apply-mesh" :disabled="!canApply" @click="emit('apply')"><Icon name="check"/>应用</button>
    </footer>
  </section>
</template>
