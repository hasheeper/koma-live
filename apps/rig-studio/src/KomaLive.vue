<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  GeometryError,
  type LogicalPointer,
  type PerformanceMeta,
  type Point,
  type Pose,
  type WorkViewportInput,
} from '@koma-rig/rig-core'
import {
  mountPerformance,
  type MountedPerformance,
  type PerformanceFrameSnapshot,
  type PerformanceLayoutSnapshot,
} from '@koma-rig/rig-renderer'
import BrandMark from './BrandMark.vue'
import Icon from './Icon.vue'
import {
  builtinLiveWork,
  liveWorkFromProject,
  loadDevWorkDirectory,
  loadLocalWorkDirectory,
  loadLocalWorkFiles,
  type LiveWorkBundle,
} from './live-work'
import {
  extractDroppedPayload,
  rememberOpenedSource,
  type DevWorkSummary,
} from './local-session'
import {
  queryDirPermission,
  requestDirPermission,
  type RecentDirEntry,
} from './recent-handles'
import type { Project } from './project'

type Backdrop = 'auto' | 'checker' | 'dark' | 'light'
type FramePreset = 'full-center' | 'full-bottom' | 'card-portrait' | 'card-landscape'

const props = defineProps<{
  theme: 'dark' | 'light'
  studioProject?: Project
  studioRig?: unknown
  studioDirty?: boolean
  savedSession?: { bundle: LiveWorkBundle; state?: string } | null
  initialDevWork?: string
  initialFsEntry?: RecentDirEntry | null
  pendingResume?: RecentDirEntry | null
  recentDirs: RecentDirEntry[]
  devWorks: DevWorkSummary[]
}>()

const emit = defineEmits<{
  backToStudio: [snapshot: { bundle?: LiveWorkBundle; state: string }]
  toggleTheme: []
  workChanged: [info: { devPath?: string; clearResume?: boolean }]
  dismissResume: []
  clearRecent: []
}>()

const mountHost = ref<HTMLElement>()
const overlayCanvas = ref<HTMLCanvasElement>()
const workFolderInput = ref<HTMLInputElement>()
const scriptFileInput = ref<HTMLInputElement>()

const menu = ref(false)
const busy = ref(false)
const inspect = ref(false)
const pointerTracking = ref(true)
const autoReload = ref(true)
const dropActive = ref(false)
const backdrop = ref<Backdrop>('auto')
const framePreset = ref<FramePreset>('full-center')

const activeWork = shallowRef<LiveWorkBundle>()
const ready = ref(false)
const meta = shallowRef<PerformanceMeta>({ format: 'koma-rig.performance.v1' })
const playing = ref(false)
const timeScale = ref(1)
const currentTimeMs = ref(0)
const currentState = ref('idle')
const errorMessage = ref('')
const syncToast = ref('')
const copiedNotice = ref(false)
const issuePolygons = shallowRef<Point[][]>([])

let mounted: MountedPerformance | undefined
let latestPose: Pose | undefined
let latestLayout: PerformanceLayoutSnapshot | undefined
let latestPointer: LogicalPointer | undefined
let loadGeneration = 0
let scriptHandle: FileSystemFileHandle | undefined
let scriptStatSig = ''
let toastTimer: number | undefined
let watchTimer: number | undefined
let checkingUpdates = false
let dragDepth = 0

const hasScript = computed(() => Boolean(activeWork.value?.performanceCode))
const canWatch = computed(() => Boolean(activeWork.value?.checkForUpdates || scriptHandle))
const backdropClass = computed(() => {
  if (backdrop.value === 'auto') return props.theme === 'dark' ? 'bg-dark' : 'bg-light'
  return 'bg-' + backdrop.value
})
const frameLabel = computed(() => {
  switch (framePreset.value) {
    case 'full-center':
      return '居中适屏'
    case 'full-bottom':
      return '底边贴齐'
    case 'card-portrait':
      return '竖卡 360×540'
    case 'card-landscape':
      return '横卡 640×360'
  }
})
const backdropLabel = computed(() => {
  switch (backdrop.value) {
    case 'auto':
      return '跟随主题'
    case 'checker':
      return '透明棋盘格'
    case 'dark':
      return '暗夜底色'
    case 'light':
      return '柔浅底色'
  }
})
const formattedTime = computed(() => (currentTimeMs.value / 1000).toFixed(2) + 's')

function flashToast(text: string) {
  syncToast.value = text
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    syncToast.value = ''
    toastTimer = undefined
  }, 2000)
}

function nowStamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function viewportForPreset(preset: FramePreset, workDefault?: WorkViewportInput): WorkViewportInput {
  if (preset === 'full-bottom') {
    return { fit: 'contain', anchor: [0.5, 1], paddingPx: workDefault?.paddingPx ?? 20 }
  }
  if (preset === 'card-portrait') {
    return { fit: 'contain', anchor: [0.5, 1], paddingPx: 12 }
  }
  if (preset === 'card-landscape') {
    return { fit: 'contain', anchor: [0.5, 0.5], paddingPx: 12 }
  }
  return {
    fit: workDefault?.fit ?? 'contain',
    anchor: workDefault?.anchor ?? [0.5, 0.5],
    paddingPx: workDefault?.paddingPx ?? 24,
  }
}

function drawOverlay() {
  const canvas = overlayCanvas.value
  const host = mountHost.value
  if (!canvas || !host) return
  const showOverlay = inspect.value || issuePolygons.value.length > 0
  if (!showOverlay || !latestLayout || !latestPose) {
    canvas.width = 0
    canvas.height = 0
    return
  }
  const w = host.clientWidth
  const h = host.clientHeight
  if (!(w > 0 && h > 0)) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const bw = Math.round(w * dpr)
  const bh = Math.round(h * dpr)
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw
    canvas.height = bh
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const { offsetX, offsetY, scale, canvasWidth, canvasHeight } = latestLayout
  const toScreen = (x: number, y: number): Point => [offsetX + x * scale, offsetY + y * scale]

  ctx.save()
  if (inspect.value) {
    ctx.strokeStyle = 'rgba(61, 242, 255, 0.42)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, canvasWidth * scale, canvasHeight * scale)
    ctx.setLineDash([])

    ctx.strokeStyle = 'rgba(61, 242, 255, 0.25)'
    ctx.lineWidth = 1
    for (const part of latestPose.parts) {
      if (!part.visible || !part.geometry) continue
      const { vertices, indices } = part.geometry
      const m = part.matrix
      ctx.beginPath()
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]! * 2
        const b = indices[i + 1]! * 2
        const c = indices[i + 2]! * 2
        const pa = toScreen(
          m[0] * vertices[a]! + m[2] * vertices[a + 1]! + m[4],
          m[1] * vertices[a]! + m[3] * vertices[a + 1]! + m[5],
        )
        const pb = toScreen(
          m[0] * vertices[b]! + m[2] * vertices[b + 1]! + m[4],
          m[1] * vertices[b]! + m[3] * vertices[b + 1]! + m[5],
        )
        const pc = toScreen(
          m[0] * vertices[c]! + m[2] * vertices[c + 1]! + m[4],
          m[1] * vertices[c]! + m[3] * vertices[c + 1]! + m[5],
        )
        ctx.moveTo(pa[0], pa[1])
        ctx.lineTo(pb[0], pb[1])
        ctx.lineTo(pc[0], pc[1])
        ctx.closePath()
      }
      ctx.stroke()
    }

    for (const bone of latestPose.bones ?? []) {
      const a = toScreen(bone.start[0], bone.start[1])
      const b = toScreen(bone.end[0], bone.end[1])
      ctx.strokeStyle = 'rgba(61, 242, 255, 0.85)'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
      ctx.fillStyle = '#0e1015'
      ctx.beginPath()
      ctx.arc(a[0], a[1], 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    if (latestPointer?.inside) {
      const pt = toScreen(latestPointer.x, latestPointer.y)
      ctx.strokeStyle = 'rgba(255, 198, 92, 0.7)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(pt[0] - 8, pt[1])
      ctx.lineTo(pt[0] + 8, pt[1])
      ctx.moveTo(pt[0], pt[1] - 8)
      ctx.lineTo(pt[0], pt[1] + 8)
      ctx.stroke()
      const label = `${Math.round(latestPointer.x)}, ${Math.round(latestPointer.y)}`
      ctx.font = '11px var(--mono)'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(15, 17, 22, 0.8)'
      ctx.fillRect(pt[0] + 10, pt[1] - 18, tw + 10, 18)
      ctx.fillStyle = '#f8fafc'
      ctx.fillText(label, pt[0] + 15, pt[1] - 5)
    }
  }

  if (issuePolygons.value.length) {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.36)'
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.95)'
    ctx.lineWidth = 1.8
    for (const poly of issuePolygons.value) {
      if (poly.length < 3) continue
      const first = toScreen(poly[0]![0], poly[0]![1])
      ctx.beginPath()
      ctx.moveTo(first[0], first[1])
      for (let i = 1; i < poly.length; i++) {
        const pt = toScreen(poly[i]![0], poly[i]![1])
        ctx.lineTo(pt[0], pt[1])
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
}

function teardown() {
  mounted?.destroy()
  mounted = undefined
  ready.value = false
  latestPose = undefined
  latestLayout = undefined
  latestPointer = undefined
  playing.value = false
  issuePolygons.value = []
}

async function mountBundle(bundle: LiveWorkBundle, preserveState?: string) {
  const token = ++loadGeneration
  busy.value = true
  errorMessage.value = ''
  issuePolygons.value = []
  teardown()
  activeWork.value = bundle
  const host = mountHost.value
  if (!host) {
    busy.value = false
    return
  }
  try {
    const instance = await mountPerformance(host, {
      rig: bundle.rig,
      performance: bundle.performanceCode
        ? { code: bundle.performanceCode, filename: bundle.performanceFilename }
        : undefined,
      poster: bundle.poster,
      viewport: viewportForPreset(framePreset.value, bundle.viewport),
      initialState: preserveState ?? bundle.defaultState,
      pointerTracking: pointerTracking.value,
      timeScale: timeScale.value,
      validateGeometry: inspect.value,
      errorPolicy: 'pause',
      onError(err) {
        if (token !== loadGeneration) return
        errorMessage.value = err instanceof Error ? err.message : String(err)
        issuePolygons.value = err instanceof GeometryError ? err.polygons : []
        playing.value = false
        drawOverlay()
      },
      onFrame(snapshot: PerformanceFrameSnapshot) {
        if (token !== loadGeneration) return
        latestPose = snapshot.pose
        latestPointer = snapshot.pointer
        currentTimeMs.value = snapshot.timeMs
        currentState.value = snapshot.state
        playing.value = snapshot.playing
        if (inspect.value || issuePolygons.value.length) drawOverlay()
      },
      onLayout(layout: PerformanceLayoutSnapshot) {
        if (token !== loadGeneration) return
        latestLayout = layout
        if (inspect.value || issuePolygons.value.length) drawOverlay()
      },
    })
    if (token !== loadGeneration) {
      instance.destroy()
      return
    }
    mounted = instance
    ready.value = true
    meta.value = instance.meta
    playing.value = instance.playing
    currentState.value = instance.state
    currentTimeMs.value = instance.timeMs
    latestPose = instance.puppet.pose
    latestLayout = instance.getLayout()
    drawOverlay()
  } catch (err) {
    if (token !== loadGeneration) return
    errorMessage.value = err instanceof Error ? err.message : String(err)
    issuePolygons.value = err instanceof GeometryError ? err.polygons : []
  } finally {
    if (token === loadGeneration) busy.value = false
  }
}

async function loadWork(
  loader: () => Promise<LiveWorkBundle>,
  options?: { remember?: boolean; preserveState?: string; notifyParent?: boolean },
) {
  menu.value = false
  scriptHandle = undefined
  scriptStatSig = ''
  try {
    const bundle = await loader()
    if (options?.remember && bundle.source && bundle.layout) {
      await rememberOpenedSource(bundle.source, bundle.layout)
    }
    if (options?.notifyParent !== false) {
      emit('workChanged', {
        devPath: bundle.source?.devPath,
        clearResume: Boolean(bundle.source),
      })
    }
    await mountBundle(bundle, options?.preserveState)
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function openLocalWorkFolder() {
  menu.value = false
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker
  if (!picker) {
    workFolderInput.value?.click()
    return
  }
  try {
    const handle = await picker.call(window)
    await loadWork(() => loadLocalWorkDirectory(handle), { remember: true })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function openRecentEntry(entry: RecentDirEntry) {
  menu.value = false
  try {
    const granted =
      (await queryDirPermission(entry.handle, 'read')) === 'granted' ||
      (await requestDirPermission(entry.handle, 'read'))
    if (!granted) {
      errorMessage.value = `未获得目录访问权限 · ${entry.name}`
      return
    }
    await loadWork(() => loadLocalWorkDirectory(entry.handle, entry.id), { remember: true })
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function openDevWork(relPath: string) {
  await loadWork(() => loadDevWorkDirectory(relPath), { remember: true })
}

async function onWorkFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  await loadWork(() => loadLocalWorkFiles(files))
}

async function mountStandaloneScript(file: File, handle?: FileSystemFileHandle) {
  if (!activeWork.value) return
  scriptHandle = handle
  scriptStatSig = handle ? `${Math.round(file.lastModified)}:${file.size}` : ''
  const code = await file.text()
  const base = activeWork.value
  await mountBundle(
    {
      ...base,
      performanceCode: code,
      performanceFilename: file.name,
      reloadScript: handle
        ? async () => {
            const fresh = await handle.getFile()
            scriptStatSig = `${Math.round(fresh.lastModified)}:${fresh.size}`
            return { code: await fresh.text(), filename: fresh.name }
          }
        : undefined,
    },
    currentState.value,
  )
}

async function pickPerformanceScript() {
  menu.value = false
  const picker = (
    window as Window & {
      showOpenFilePicker?: (opts?: {
        types?: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<FileSystemFileHandle[]>
    }
  ).showOpenFilePicker
  if (!picker) {
    scriptFileInput.value?.click()
    return
  }
  try {
    const [handle] = await picker.call(window, {
      types: [{ description: 'Koma Performance ES Module', accept: { 'text/javascript': ['.js', '.mjs'] } }],
    })
    if (!handle || !activeWork.value) return
    const file = await handle.getFile()
    await mountStandaloneScript(file, handle)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function onScriptFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !activeWork.value) return
  await mountStandaloneScript(file, undefined)
}

async function reloadPerformance(reason: 'manual' | 'auto' = 'manual') {
  const work = activeWork.value
  if (!work) return
  try {
    let nextBundle: LiveWorkBundle = work
    if (work.reloadWork) {
      nextBundle = await work.reloadWork()
      if (scriptHandle) {
        const fresh = await scriptHandle.getFile()
        scriptStatSig = `${Math.round(fresh.lastModified)}:${fresh.size}`
        nextBundle = {
          ...nextBundle,
          performanceCode: await fresh.text(),
          performanceFilename: fresh.name,
        }
      }
    } else if (work.reloadScript) {
      const fresh = await work.reloadScript()
      if (fresh) {
        nextBundle = { ...work, performanceCode: fresh.code, performanceFilename: fresh.filename }
      }
    } else if (scriptHandle) {
      const fresh = await scriptHandle.getFile()
      scriptStatSig = `${Math.round(fresh.lastModified)}:${fresh.size}`
      nextBundle = { ...work, performanceCode: await fresh.text(), performanceFilename: fresh.name }
    }
    await mountBundle(nextBundle, currentState.value)
    if (reason === 'auto') flashToast(`已自动热重载 · ${nowStamp()}`)
    else if (work.reloadWork || work.reloadScript || scriptHandle) flashToast(`已重载作品 · ${nowStamp()}`)
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}

async function pollForUpdates() {
  if (!autoReload.value || busy.value || checkingUpdates || document.visibilityState !== 'visible') return
  const work = activeWork.value
  if (!work) return
  checkingUpdates = true
  try {
    let changed = false
    if (work.checkForUpdates) {
      changed = await work.checkForUpdates()
    }
    if (!changed && scriptHandle) {
      const fresh = await scriptHandle.getFile()
      const sig = `${Math.round(fresh.lastModified)}:${fresh.size}`
      if (sig !== scriptStatSig) changed = true
    }
    if (changed) {
      await reloadPerformance('auto')
    }
  } catch {
    // Ignore transient file locks during atomic editor writes
  } finally {
    checkingUpdates = false
  }
}

function handleDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  dragDepth++
  dropActive.value = true
}

function handleDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropActive.value = false
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragDepth = 0
  dropActive.value = false
  try {
    const payload = await extractDroppedPayload(e.dataTransfer)
    if (!payload) return
    if (payload.kind === 'directory') {
      await loadWork(() => loadLocalWorkDirectory(payload.handle), { remember: true })
      return
    }
    if (/\.(m?js)$/i.test(payload.file.name)) {
      if (!activeWork.value) {
        errorMessage.value = '请先打开一个角色作品目录，再拖入演出脚本 (.js)。'
        return
      }
      await mountStandaloneScript(payload.file, payload.handle)
      flashToast(`已载入脚本 · ${payload.file.name}`)
      return
    }
    errorMessage.value = '请拖入作品目录（含 koma-work.json / manifest.json）或演出脚本 (.js)。'
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  }
}

function handleBackToStudio() {
  emit('backToStudio', {
    bundle: activeWork.value,
    state: currentState.value,
  })
}

function togglePlay() {
  if (!mounted) return
  if (mounted.playing) {
    mounted.pause()
  } else {
    errorMessage.value = ''
    issuePolygons.value = []
    mounted.play()
  }
  playing.value = mounted.playing
}

function resetPerformance() {
  if (!mounted) return
  errorMessage.value = ''
  issuePolygons.value = []
  mounted.reset()
  drawOverlay()
}

function stepForward(deltaMs: number) {
  if (!mounted) return
  errorMessage.value = ''
  issuePolygons.value = []
  mounted.stepTo(Math.max(0, Math.round(mounted.timeMs + deltaMs)))
  playing.value = mounted.playing
  drawOverlay()
}

function cycleTimeScale() {
  const order = [1, 0.5, 0.25]
  const next = order[(order.indexOf(timeScale.value) + 1) % order.length] ?? 1
  timeScale.value = next
  mounted?.setTimeScale(next)
}

function selectState(state: string) {
  currentState.value = state
  mounted?.setState(state)
}

function fireTrigger(name: string) {
  mounted?.trigger(name)
}

function cycleBackdrop() {
  const order: Backdrop[] = ['auto', 'checker', 'dark', 'light']
  backdrop.value = order[(order.indexOf(backdrop.value) + 1) % order.length] ?? 'auto'
}

function cycleFramePreset() {
  const order: FramePreset[] = ['full-center', 'full-bottom', 'card-portrait', 'card-landscape']
  framePreset.value = order[(order.indexOf(framePreset.value) + 1) % order.length] ?? 'full-center'
}

function onHostPointerMove() {
  if (mounted && inspect.value && !playing.value) {
    latestPointer = mounted.pointer
    drawOverlay()
  }
}

async function copyDiagnostic() {
  if (!errorMessage.value) return
  const payload = [
    `[Koma Live Diagnostic]`,
    `work: ${activeWork.value?.title ?? 'unknown'}`,
    `script: ${activeWork.value?.performanceFilename ?? 'none'}`,
    `timeMs: ${Math.round(currentTimeMs.value)}`,
    `state: ${currentState.value}`,
    `error: ${errorMessage.value}`,
  ].join('\n')
  try {
    await navigator.clipboard?.writeText(payload)
    copiedNotice.value = true
    setTimeout(() => (copiedNotice.value = false), 1500)
  } catch {
    // ignore clipboard restrictions
  }
}

function onWindowFocus() {
  void pollForUpdates()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void pollForUpdates()
}

watch(framePreset, () => {
  if (!mounted || !activeWork.value) return
  mounted.setViewport(viewportForPreset(framePreset.value, activeWork.value.viewport))
})

watch(inspect, (enabled) => {
  mounted?.setValidateGeometry(enabled)
  drawOverlay()
})
watch(pointerTracking, (enabled) => {
  mounted?.setPointerTracking(enabled)
  if (!enabled && inspect.value) {
    latestPointer = mounted?.pointer
    drawOverlay()
  }
})

onMounted(async () => {
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
  watchTimer = window.setInterval(() => void pollForUpdates(), 900)

  if (props.savedSession?.bundle) {
    const saved = props.savedSession
    if (saved.bundle.reloadWork) {
      await loadWork(() => saved.bundle.reloadWork!(), {
        preserveState: saved.state,
        notifyParent: false,
      })
    } else {
      await mountBundle(saved.bundle, saved.state)
    }
    return
  }

  if (props.initialDevWork) {
    await loadWork(() => loadDevWorkDirectory(props.initialDevWork!), { remember: true })
    return
  }

  if (props.initialFsEntry) {
    await loadWork(
      () => loadLocalWorkDirectory(props.initialFsEntry!.handle, props.initialFsEntry!.id),
      { remember: true },
    )
    return
  }

  if (props.studioProject && props.studioRig) {
    await loadWork(
      () => liveWorkFromProject(props.studioProject!, props.studioRig, { preferDiskRig: !props.studioDirty }),
      { notifyParent: false },
    )
  } else {
    await loadWork(() => builtinLiveWork('gbot'), { notifyParent: false })
  }
})

onBeforeUnmount(() => {
  loadGeneration++
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (watchTimer !== undefined) window.clearInterval(watchTimer)
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  teardown()
})
</script>

<template>
  <main class="studio koma-live" :data-theme="theme">
    <div class="commands live-commands">
      <div v-if="menu" class="menu-scrim" @click="menu = false"></div>
      <div class="project-island">
        <BrandMark subtitle="LIVE" />
        <div class="file-area">
          <button
            class="file-button"
            :aria-expanded="menu"
            aria-label="作品菜单"
            :title="activeWork?.title ?? '作品'"
            @click="menu = !menu"
          >
            <Icon name="folder" class="file-folder" />
            <span class="file-name">{{ activeWork?.title ?? 'Koma Live' }}</span>
            <Icon name="chevron" class="file-caret" />
          </button>
          <nav v-if="menu" class="file-menu" aria-label="动帧作品操作">
            <button @click="openLocalWorkFolder">
              <Icon name="folder" />打开作品目录 (koma-work.json)…
            </button>
            <button :disabled="!activeWork" @click="pickPerformanceScript">
              <Icon name="import" />载入单文件演出脚本 (.js)…
            </button>

            <template v-if="devWorks.length">
              <hr />
              <div class="menu-section-head"><span>本地工作区</span></div>
              <button
                v-for="w in devWorks"
                :key="w.path"
                :class="{ active: activeWork?.source?.devPath === w.path }"
                :title="w.path"
                @click="openDevWork(w.path)"
              >
                <Icon name="folder" /><span class="menu-item-label">{{ w.title }}</span>
              </button>
            </template>

            <template v-if="recentDirs.length">
              <hr />
              <div class="menu-section-head">
                <span>最近打开</span>
                <button class="menu-clear-btn" title="清空最近记录" @click.stop="emit('clearRecent')">清空</button>
              </div>
              <button
                v-for="entry in recentDirs"
                :key="entry.id"
                :class="{ active: activeWork?.source?.id === entry.id }"
                :title="entry.name"
                @click="openRecentEntry(entry)"
              >
                <Icon name="recent" /><span class="menu-item-label">{{ entry.title }}</span>
              </button>
            </template>

            <hr />
            <button
              v-if="studioProject && studioRig"
              @click="
                loadWork(
                  () => liveWorkFromProject(studioProject!, studioRig, { preferDiskRig: !studioDirty }),
                  { notifyParent: false },
                )
              "
            >
              当前工作台 · {{ studioProject.name }}
            </button>
            <button @click="loadWork(() => builtinLiveWork('gbot'))">GBot · 活体动帧</button>
          </nav>
        </div>
      </div>

      <div class="live-spacer" aria-hidden="true"></div>

      <div class="view-controls live-view-controls">
        <button
          class="live-switch-btn"
          aria-label="切回绑骨 Studio"
          title="切回 Koma Studio 绑骨工作台"
          @click="handleBackToStudio"
        >
          <Icon name="bone" /><span>绑骨</span>
        </button>
        <i class="live-divider" aria-hidden="true"></i>
        <button
          aria-label="重载作品"
          title="重载作品 (同步 rig.json、koma-work.json 与演出脚本)"
          :disabled="!activeWork"
          @click="reloadPerformance('manual')"
        >
          <Icon name="reload" />
        </button>
        <button
          v-if="canWatch"
          aria-label="自动热重载"
          :title="autoReload ? '自动热重载已开启：检测到文件改动自动同步（点击暂停）' : '开启自动热重载监听'"
          :aria-pressed="autoReload"
          @click="autoReload = !autoReload"
        >
          <Icon name="auto-reload" />
        </button>
        <button
          aria-label="鼠标跟随"
          :title="pointerTracking ? '关闭鼠标跟随反应' : '开启鼠标跟随反应'"
          :aria-pressed="pointerTracking"
          @click="pointerTracking = !pointerTracking"
        >
          <Icon name="select-cursor" />
        </button>
        <button
          aria-label="审查叠加层"
          :title="inspect ? '关闭骨骼与网格审查叠加层' : '开启骨骼、网格与逻辑坐标审查叠加层'"
          :aria-pressed="inspect"
          @click="inspect = !inspect"
        >
          <Icon :name="inspect ? 'eye' : 'eye-off'" />
        </button>
        <button
          aria-label="视口框实测"
          :title="'视口实测：' + frameLabel + '（点击切换）'"
          :aria-pressed="framePreset !== 'full-center'"
          @click="cycleFramePreset"
        >
          <Icon name="frame-card" />
        </button>
        <button aria-label="切换主题" title="切换深浅主题" @click="emit('toggleTheme')">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" />
        </button>
      </div>
    </div>

    <section
      class="live-stage-area"
      :class="[backdropClass, { 'drop-active': dropActive }]"
      aria-label="动帧画布"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div
        class="live-frame"
        :class="'preset-' + framePreset"
        @pointermove="onHostPointerMove"
      >
        <div v-if="framePreset === 'card-portrait' || framePreset === 'card-landscape'" class="live-frame-badge">
          {{ frameLabel }}
        </div>
        <div ref="mountHost" class="live-mount-host"></div>
        <canvas ref="overlayCanvas" class="live-overlay" aria-hidden="true"></canvas>
      </div>

      <div v-if="dropActive" class="drop-veil" aria-hidden="true">松开以载入作品目录或演出脚本 (.js)</div>

      <div v-if="pendingResume && !errorMessage && !busy" class="notice resume-notice" role="status">
        <span>上次打开：{{ pendingResume.title }}</span>
        <button class="notice-action" @click="openRecentEntry(pendingResume)">一键恢复</button>
        <button class="notice-dismiss" aria-label="忽略恢复提示" @click="emit('dismissResume')">×</button>
      </div>

      <div v-if="busy" class="notice" role="status">正在载入动帧作品…</div>
      <div v-else-if="syncToast && !errorMessage" class="notice sync-toast" role="status">{{ syncToast }}</div>
      <div v-if="errorMessage" class="notice problem live-diagnostic" role="alert">
        <span class="live-error-text">{{ errorMessage }}</span>
        <button class="live-diag-btn" title="复制诊断信息" @click="copyDiagnostic">
          <Icon name="copy" /><span>{{ copiedNotice ? '已复制' : '复制' }}</span>
        </button>
        <button class="live-diag-btn" title="重载作品" @click="reloadPerformance('manual')">重载</button>
        <button class="live-diag-btn" title="复位" @click="resetPerformance">复位</button>
      </div>

      <div class="live-dock-wrap">
        <div class="live-dock" role="toolbar" aria-label="动帧交互控制">
          <div class="live-dock-group">
            <button
              class="icon-button"
              :aria-label="playing ? '暂停' : '播放'"
              :title="playing ? '暂停' : '播放'"
              :disabled="!ready"
              @click="togglePlay"
            >
              <Icon :name="playing ? 'pause' : 'play'" />
            </button>
            <button
              class="icon-button"
              aria-label="复位动帧"
              title="复位到 0.00s"
              :disabled="!ready"
              @click="resetPerformance"
            >
              <Icon name="reset-pose" />
            </button>
            <button
              class="live-pill mono-pill"
              title="切换倍速 (1× / 0.5× / 0.25×)"
              @click="cycleTimeScale"
            >
              {{ timeScale }}×
            </button>
            <button
              class="live-pill mono-pill"
              title="点击按确定性固定步长前进 +100ms"
              :disabled="!ready"
              @click="stepForward(100)"
            >
              {{ formattedTime }}
            </button>
          </div>

          <template v-if="meta.states?.length">
            <i class="separator" aria-hidden="true"></i>
            <div class="live-dock-group" role="group" aria-label="演出状态">
              <button
                v-for="s in meta.states"
                :key="s"
                class="live-pill"
                :aria-pressed="currentState === s"
                @click="selectState(s)"
              >
                {{ s }}
              </button>
            </div>
          </template>

          <template v-if="meta.triggers?.length">
            <i class="separator" aria-hidden="true"></i>
            <div class="live-dock-group" role="group" aria-label="交互触发">
              <button
                v-for="tr in meta.triggers"
                :key="tr"
                class="live-pill trigger-pill"
                @click="fireTrigger(tr)"
              >
                {{ tr }}
              </button>
            </div>
          </template>

          <template v-if="!hasScript">
            <i class="separator" aria-hidden="true"></i>
            <button class="live-pill trigger-pill" @click="pickPerformanceScript">载入演出脚本 (.js)…</button>
          </template>

          <i class="separator" aria-hidden="true"></i>
          <div class="live-dock-group">
            <button
              class="live-pill"
              :title="'环境底色：' + backdropLabel + '（点击切换检查透明边缘）'"
              @click="cycleBackdrop"
            >
              {{ backdropLabel }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <input ref="workFolderInput" hidden type="file" webkitdirectory multiple @change="onWorkFilesSelected" />
    <input ref="scriptFileInput" hidden type="file" accept=".js,.mjs,text/javascript" @change="onScriptFileSelected" />
  </main>
</template>
