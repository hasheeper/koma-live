<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Bone, BoneTransform, Rig } from '@koma-rig/rig-core'
import type { Mode } from './project'
import Icon from './Icon.vue'
import ScrubNumber from './ScrubNumber.vue'

const props = defineProps<{
  bone: Bone
  model: Rig
  mode: Mode
  poseTransform: BoneTransform
  pickingParent: boolean
  canPickParent: boolean
  deleteBlocker: string
}>()

const emit = defineEmits<{
  rename: [name: string]
  editProp: [prop: 'x' | 'y' | 'rotation' | 'length', value: number | undefined, commit: boolean]
  poseProp: [prop: 'rotation' | 'x' | 'y' | 'scaleX' | 'scaleY', value: number | undefined, commit: boolean]
  selectBone: [id: string]
  hoverBone: [id?: string]
  beginPickParent: []
  cancelPickParent: []
  clearParent: []
  remove: []
  resetPose: []
}>()

const renaming = ref(false)
const draftName = ref('')
const nameInput = ref<HTMLInputElement>()

const displayName = computed(() => props.bone.name ?? props.bone.boneId)
const parentName = computed(() => {
  const id = props.bone.parentBoneId
  if (!id) return ''
  return props.model.skeleton.byId.get(id)?.name ?? id
})

async function startRename() {
  if (props.mode !== 'setup') return
  draftName.value = displayName.value
  renaming.value = true
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function cancelRename() {
  renaming.value = false
}

function commitRename() {
  if (!renaming.value) return
  const next = draftName.value.trim()
  renaming.value = false
  if (next && next !== displayName.value) emit('rename', next)
}

watch(() => [props.bone.boneId, props.mode], () => {
  renaming.value = false
})

defineExpose({ startRename })
</script>

<template>
  <section class="bone-inspector" aria-label="骨骼属性">
    <div class="object-head" :title="displayName + ' (' + bone.boneId + ')'">
      <Icon :name="bone.length ? 'bone' : 'bone-point'" />
      <input v-if="renaming" ref="nameInput" v-model="draftName" class="head-name-input" type="text"
        aria-label="骨骼名称" @keydown.enter.prevent="commitRename" @keydown.esc.prevent="cancelRename" @blur="commitRename">
      <button v-else-if="mode==='setup'" class="head-name" title="点击重命名 (F2)" @click="startRename">{{ displayName }}</button>
      <strong v-else>{{ displayName }}</strong>
      <code>{{ bone.boneId }}</code>
    </div>

    <section class="props-body rest-properties" aria-label="静止姿势">
      <div class="section-heading">
        <strong>静止姿势</strong>
        <button v-if="mode==='setup'" class="heading-action danger" aria-label="删除骨骼" :disabled="!!deleteBlocker"
          :title="deleteBlocker || '删除骨骼 (Delete)'" @click="emit('remove')"><Icon name="trash" /></button>
        <span v-else class="section-tag">只读</span>
      </div>

      <div class="property-row">
        <span class="property-name">父骨</span>
        <div class="bone-slot" :class="{ armed: pickingParent, unassigned: !bone.parentBoneId }">
          <button v-if="bone.parentBoneId" class="slot-value" :title="'选中父骨 ' + parentName"
            @pointerenter="emit('hoverBone', bone.parentBoneId)" @pointerleave="emit('hoverBone', undefined)"
            @click="emit('selectBone', bone.parentBoneId)">
            <Icon name="bone" /><span>{{ parentName }}</span>
          </button>
          <button v-else-if="mode==='setup'" class="slot-value" :disabled="!canPickParent"
            :title="canPickParent ? '拾取父骨' : '没有可选的父骨'"
            @click="pickingParent ? emit('cancelPickParent') : emit('beginPickParent')">
            <Icon name="bone" /><span>无</span>
          </button>
          <span v-else class="slot-value empty-val"><Icon name="bone" /><span>无</span></span>

          <button v-if="mode==='setup' && bone.parentBoneId" class="slot-clear" aria-label="设为根骨"
            title="解除父骨（设为根骨）" @click="emit('clearParent')">
            <Icon name="close" />
          </button>
          <button v-if="mode==='setup'" class="pick-button" aria-label="拾取父骨" title="从画布或大纲树拾取父骨"
            :aria-pressed="pickingParent" :disabled="!canPickParent"
            @click="pickingParent ? emit('cancelPickParent') : emit('beginPickParent')">
            <Icon name="pick" />
          </button>
        </div>
      </div>

      <ScrubNumber label="局部 X" unit="px" :value="bone.x" :disabled="mode!=='setup'"
        @preview="v => emit('editProp', 'x', v, false)" @commit="v => emit('editProp', 'x', v, true)" />
      <ScrubNumber label="局部 Y" unit="px" :value="bone.y" :disabled="mode!=='setup'"
        @preview="v => emit('editProp', 'y', v, false)" @commit="v => emit('editProp', 'y', v, true)" />
      <ScrubNumber label="静止角度" unit="°" :value="bone.rotation" :disabled="mode!=='setup'"
        @preview="v => emit('editProp', 'rotation', v, false)" @commit="v => emit('editProp', 'rotation', v, true)" />
      <ScrubNumber label="长度" unit="px" :min="0" :value="bone.length" :disabled="mode!=='setup'"
        @preview="v => emit('editProp', 'length', v, false)" @commit="v => emit('editProp', 'length', v, true)" />
    </section>

    <div v-if="pickingParent" class="pick-status" role="status">
      <span>拾取父骨</span>
      <div class="pick-status-actions">
        <button v-if="bone.parentBoneId" @click="emit('clearParent')">设为根骨</button>
        <button @click="emit('cancelPickParent')" title="取消拾取">Esc</button>
      </div>
    </div>

    <section v-if="mode==='pose'" class="props-body pose-controls" aria-label="试动">
      <div class="section-heading">
        <strong>试动</strong>
        <button class="heading-action" aria-label="姿势复位" title="复位全部试动变换" @click="emit('resetPose')"><Icon name="reset-pose" /></button>
      </div>
      <ScrubNumber label="旋转" unit="°" :value="poseTransform.rotation ?? 0"
        @preview="v => emit('poseProp', 'rotation', v, false)" @commit="v => emit('poseProp', 'rotation', v, true)" />
      <ScrubNumber label="平移 X" unit="px" :value="poseTransform.x ?? 0"
        @preview="v => emit('poseProp', 'x', v, false)" @commit="v => emit('poseProp', 'x', v, true)" />
      <ScrubNumber label="平移 Y" unit="px" :value="poseTransform.y ?? 0"
        @preview="v => emit('poseProp', 'y', v, false)" @commit="v => emit('poseProp', 'y', v, true)" />
      <ScrubNumber label="缩放 X" unit="×" :min="0.05" :step="0.02" :value="poseTransform.scaleX ?? 1"
        @preview="v => emit('poseProp', 'scaleX', v, false)" @commit="v => emit('poseProp', 'scaleX', v, true)" />
      <ScrubNumber label="缩放 Y" unit="×" :min="0.05" :step="0.02" :value="poseTransform.scaleY ?? 1"
        @preview="v => emit('poseProp', 'scaleY', v, false)" @commit="v => emit('poseProp', 'scaleY', v, true)" />
    </section>
  </section>
</template>
