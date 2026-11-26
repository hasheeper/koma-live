import {
  assertStandalonePerformanceSource,
  computeFixedSteps,
  computeLayerPixelScale,
  computeViewportLayout,
  createErrorGate,
  createPhysicsToolkit,
  mapClientToLogicalPointer,
  performanceMetaSchema,
  resolveViewport,
  workManifestSchema,
  type LogicalPointer,
  type PerformanceErrorPolicy,
  type PerformanceMeta,
  type PhysicsToolkit,
  type Pose,
  type ViewportLayout,
  type WorkViewport,
  type WorkViewportInput,
} from '@koma-rig/rig-core'
import { mountLiveRig, type LiveRigPlayer, type LiveRigSource } from './game.js'

export interface PerformanceFrame {
  timeMs: number
  dtMs: number
  pointer: LogicalPointer
  state: string
}

export interface PerformanceLayerSlot {
  canvas: HTMLCanvasElement
  ctx2d: CanvasRenderingContext2D | null
  pixelScale: number
}

export interface PerformanceContext {
  puppet: LiveRigPlayer
  size: { width: number; height: number }
  physics: PhysicsToolkit
  back?: PerformanceLayerSlot
  front?: PerformanceLayerSlot
}

export interface PerformanceInstance {
  update(frame: PerformanceFrame): void
  trigger?(name: string, payload?: unknown): void
  setState?(state: string): void
  reset?(): void
  destroy?(): void
}

export type PerformanceFactory = (
  ctx: PerformanceContext,
) => PerformanceInstance | Promise<PerformanceInstance>

export interface PerformanceModule {
  meta?: PerformanceMeta
  default: PerformanceFactory
}

export interface PerformanceCodeSource {
  code: string
  filename?: string
}

export type PerformanceSource =
  | string
  | URL
  | PerformanceCodeSource
  | PerformanceModule
  | PerformanceFactory

export interface PerformanceLayoutSnapshot extends ViewportLayout {
  canvasWidth: number
  canvasHeight: number
  pixelScale: number
}

export interface PerformanceFrameSnapshot {
  timeMs: number
  pose: Pose
  pointer: LogicalPointer
  state: string
  playing: boolean
}

export interface MountPerformanceOptions {
  work?: string | URL
  rig?: string | URL | LiveRigSource
  performance?: PerformanceSource
  poster?: string | URL | Blob
  viewport?: WorkViewportInput
  initialState?: string
  autoplay?: boolean
  pointerTracking?: boolean
  timeScale?: number
  stepMs?: number
  maxDpr?: number
  /** Backing resolution multiplier in `(0, 1]` for coaxial 2D `back`/`front` layers (e.g. `0.5` saves 75% fill-rate). */
  layerResolutionScale?: number
  /** Run per-frame checkGeometry() self-intersection audit (defaults to `false` in playback; `true` in inspect/audit). */
  validateGeometry?: boolean
  errorPolicy?: PerformanceErrorPolicy
  errorThrottleMs?: number
  onError?: (error: unknown) => void
  onFrame?: (snapshot: PerformanceFrameSnapshot) => void
  onLayout?: (layout: PerformanceLayoutSnapshot) => void
}

export interface MountedPerformance {
  element: HTMLElement
  stackElement: HTMLElement
  puppet: LiveRigPlayer
  meta: PerformanceMeta
  readonly playing: boolean
  readonly pointerTracking: boolean
  readonly timeMs: number
  readonly state: string
  readonly pointer: LogicalPointer
  readonly lastError: unknown
  play(): void
  pause(): void
  setPointerTracking(enabled: boolean): void
  setValidateGeometry(enabled: boolean): void
  setTimeScale(scale: number): void
  advanceBy(deltaMs: number): void
  stepTo(timeMs: number): void
  reset(): void
  setPointer(pointer: Partial<LogicalPointer>): void
  setState(state: string): void
  trigger(name: string, payload?: unknown): void
  setViewport(viewport?: WorkViewportInput): void
  getLayout(): PerformanceLayoutSnapshot
  destroy(): void
}

const DEFAULT_META: PerformanceMeta = {
  format: 'koma-rig.performance.v1',
}

function defaultIdlePerformance(ctx: PerformanceContext): PerformanceInstance {
  let rendered = false
  return {
    reset() {
      rendered = false
    },
    update() {
      if (!rendered) {
        ctx.puppet.reset()
        rendered = true
      }
    },
  }
}

async function importStandaloneCode(code: string, label?: string): Promise<PerformanceModule> {
  assertStandalonePerformanceSource(code)
  const source = label ? `${code}\n//# sourceURL=${label.replace(/[\r\n]/g, '')}\n` : code
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as Partial<PerformanceModule>
    if (typeof mod.default !== 'function') {
      throw new Error('演出脚本缺少默认导出函数 export default function createPerformance(ctx)')
    }
    return { meta: mod.meta, default: mod.default }
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

async function resolvePerformanceSource(source?: PerformanceSource): Promise<{
  meta: PerformanceMeta
  factory: PerformanceFactory
}> {
  if (!source) {
    return { meta: DEFAULT_META, factory: defaultIdlePerformance }
  }
  if (typeof source === 'function') {
    return { meta: DEFAULT_META, factory: source }
  }
  let mod: PerformanceModule
  if (typeof source === 'string' || source instanceof URL) {
    const url = new URL(String(source), document.baseURI)
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`加载演出脚本失败 (${response.status}) · ${url.pathname}`)
    const code = await response.text()
    mod = await importStandaloneCode(code, url.href)
  } else if ('code' in source) {
    mod = await importStandaloneCode(source.code, source.filename)
  } else {
    if (typeof source.default !== 'function') {
      throw new Error('演出模块缺少默认导出函数 export default function createPerformance(ctx)')
    }
    mod = source
  }
  const meta = mod.meta ? performanceMetaSchema.parse(mod.meta) : DEFAULT_META
  return { meta, factory: mod.default }
}

function createCoaxialCanvas(): PerformanceLayerSlot {
  const canvas = document.createElement('canvas')
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  canvas.style.pointerEvents = 'none'
  const ctx2d = canvas.getContext('2d')
  return { canvas, ctx2d, pixelScale: 1 }
}

function resetLayerSlotTransform(slot?: PerformanceLayerSlot) {
  if (slot?.ctx2d) {
    slot.ctx2d.setTransform(slot.pixelScale, 0, 0, slot.pixelScale, 0, 0)
  }
}

function clearLayerSlot(slot: PerformanceLayerSlot | undefined, width: number, height: number) {
  if (!slot?.ctx2d) return
  slot.ctx2d.setTransform(slot.pixelScale, 0, 0, slot.pixelScale, 0, 0)
  slot.ctx2d.clearRect(0, 0, width, height)
}

/**
 * Mount a Koma Rig puppet together with a portable koma-rig.performance.v1 module
 * inside a zero-drift coaxial box. Used identically by Koma Live and host web/game apps.
 */
export async function mountPerformance(
  host: HTMLElement,
  options: MountPerformanceOptions,
): Promise<MountedPerformance> {
  let rigSource = options.rig
  let perfSource = options.performance
  let posterSource = options.poster
  let workViewport: WorkViewportInput | undefined
  let workDefaultState: string | undefined

  if (options.work !== undefined) {
    const workUrl = new URL(String(options.work), document.baseURI)
    const response = await fetch(workUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`加载作品清单失败 (${response.status}) · ${workUrl.pathname}`)
    const manifest = workManifestSchema.parse(await response.json())
    if (!rigSource) rigSource = new URL(manifest.rig, workUrl)
    if (!perfSource && manifest.performance) perfSource = new URL(manifest.performance, workUrl)
    if (!posterSource && manifest.poster) posterSource = new URL(manifest.poster, workUrl)
    workViewport = manifest.viewport
    workDefaultState = manifest.defaultState
  }

  if (!rigSource) throw new Error('mountPerformance 需要提供 rig 资产或 work 清单')

  let viewport: WorkViewport = resolveViewport({ ...workViewport, ...options.viewport })
  const stepMs = options.stepMs ?? 10
  if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error('stepMs 必须为正数')
  const maxDpr = options.maxDpr ?? 2
  const layerResolutionScale = options.layerResolutionScale ?? 1
  if (!Number.isFinite(layerResolutionScale) || layerResolutionScale <= 0 || layerResolutionScale > 1) {
    throw new Error('layerResolutionScale 必须在 (0, 1] 范围内')
  }
  const errorGate = createErrorGate(options.errorPolicy ?? 'pause', options.errorThrottleMs ?? 1000)

  // Build coaxial container before mounting Pixi so puppet.canvas sits directly inside stack.
  const box = document.createElement('div')
  box.className = 'koma-box'
  box.style.position = 'relative'
  box.style.width = '100%'
  box.style.height = '100%'
  box.style.overflow = 'hidden'
  box.style.boxSizing = 'border-box'
  box.style.touchAction = 'manipulation'

  const stack = document.createElement('div')
  stack.className = 'koma-canvas-stack'
  stack.style.position = 'absolute'
  stack.style.left = '0'
  stack.style.top = '0'
  stack.style.transformOrigin = '0 0'
  stack.style.willChange = 'transform'
  box.appendChild(stack)

  let posterBlobUrl: string | undefined
  let posterImg: HTMLImageElement | undefined
  if (posterSource) {
    posterImg = document.createElement('img')
    posterImg.alt = ''
    posterImg.draggable = false
    posterImg.style.position = 'absolute'
    posterImg.style.inset = '0'
    posterImg.style.width = '100%'
    posterImg.style.height = '100%'
    posterImg.style.display = 'none'
    posterImg.style.pointerEvents = 'none'
    if (posterSource instanceof Blob) {
      posterBlobUrl = URL.createObjectURL(posterSource)
      posterImg.src = posterBlobUrl
    } else {
      posterImg.src = new URL(String(posterSource), document.baseURI).href
    }
    stack.appendChild(posterImg)
  }

  const puppetHost = document.createElement('canvas')
  puppetHost.style.position = 'absolute'
  puppetHost.style.inset = '0'
  puppetHost.style.width = '100%'
  puppetHost.style.height = '100%'
  puppetHost.style.display = 'block'
  puppetHost.style.pointerEvents = 'none'

  let puppet: LiveRigPlayer
  let meta: PerformanceMeta
  let factory: PerformanceFactory
  try {
    const [loadedPuppet, resolvedPerf] = await Promise.all([
      mountLiveRig(puppetHost, rigSource, { validateGeometry: options.validateGeometry === true }),
      resolvePerformanceSource(perfSource),
    ])
    puppet = loadedPuppet
    meta = resolvedPerf.meta
    factory = resolvedPerf.factory
  } catch (error) {
    if (posterBlobUrl) URL.revokeObjectURL(posterBlobUrl)
    throw error
  }

  const size = { width: puppet.spec.canvas.width, height: puppet.spec.canvas.height }
  stack.style.width = `${size.width}px`
  stack.style.height = `${size.height}px`

  const backSlot = meta.layers?.back === '2d' ? createCoaxialCanvas() : undefined
  const frontSlot = meta.layers?.front === '2d' ? createCoaxialCanvas() : undefined
  if (backSlot) stack.appendChild(backSlot.canvas)
  stack.appendChild(puppet.canvas)
  if (frontSlot) stack.appendChild(frontSlot.canvas)
  host.appendChild(box)

  let timeMs = 0
  let timeScale = options.timeScale ?? 1
  if (!Number.isFinite(timeScale) || timeScale <= 0) timeScale = 1
  let playing = false
  let pointerTracking = options.pointerTracking !== false
  let disposed = false
  let frameId: number | undefined
  let lastWallTime: number | undefined
  let lastError: unknown = undefined
  let currentState = options.initialState ?? workDefaultState ?? meta.states?.[0] ?? 'idle'
  let pointer: LogicalPointer = { inside: false, down: false, x: size.width / 2, y: size.height / 2, nx: 0, ny: 0 }
  let layout: PerformanceLayoutSnapshot = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    width: size.width,
    height: size.height,
    canvasWidth: size.width,
    canvasHeight: size.height,
    pixelScale: 1,
  }

  let instance: PerformanceInstance
  try {
    instance = await factory({
      puppet,
      size: { ...size },
      physics: createPhysicsToolkit(),
      ...(backSlot ? { back: backSlot } : {}),
      ...(frontSlot ? { front: frontSlot } : {}),
    })
  } catch (error) {
    puppet.destroy()
    box.remove()
    if (posterBlobUrl) URL.revokeObjectURL(posterBlobUrl)
    throw error
  }

  function emitFrame() {
    options.onFrame?.({
      timeMs,
      pose: puppet.pose,
      pointer: { ...pointer },
      state: currentState,
      playing,
    })
  }

  function handleError(error: unknown) {
    lastError = error
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const decision = errorGate.report(error, now)
    if (decision.shouldPause) pause()
    if (decision.notify) options.onError?.(error)
  }

  function runUpdate(nextTimeMs: number, dtMs: number, emit = true): boolean {
    if (disposed) return false
    resetLayerSlotTransform(backSlot)
    resetLayerSlotTransform(frontSlot)
    try {
      instance.update({
        timeMs: nextTimeMs,
        dtMs,
        pointer: { ...pointer },
        state: currentState,
      })
      timeMs = nextTimeMs
      if (lastError !== undefined) {
        lastError = undefined
        errorGate.clear()
      }
      if (emit) emitFrame()
      return true
    } catch (error) {
      handleError(error)
      return false
    }
  }

  function syncBackingResolution(slot: PerformanceLayerSlot | undefined, nextScale: number): boolean {
    if (!slot) return false
    const targetW = Math.max(1, Math.round(size.width * nextScale))
    const targetH = Math.max(1, Math.round(size.height * nextScale))
    const changed = slot.canvas.width !== targetW || slot.canvas.height !== targetH || slot.pixelScale !== nextScale
    if (changed) {
      slot.canvas.width = targetW
      slot.canvas.height = targetH
      slot.pixelScale = nextScale
      resetLayerSlotTransform(slot)
    }
    return changed
  }

  function syncLayout(redrawIfPaused = true) {
    if (disposed) return
    const cw = box.clientWidth || host.clientWidth || size.width
    const ch = box.clientHeight || host.clientHeight || size.height
    const next = computeViewportLayout(cw, ch, size.width, size.height, viewport)
    stack.style.transform = `translate(${next.offsetX}px, ${next.offsetY}px) scale(${next.scale})`
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const pixelScale = computeLayerPixelScale(
      dpr,
      next.scale,
      size.width,
      size.height,
      maxDpr,
      4096,
      layerResolutionScale,
    )
    const backResized = syncBackingResolution(backSlot, pixelScale)
    const frontResized = syncBackingResolution(frontSlot, pixelScale)
    layout = {
      ...next,
      canvasWidth: size.width,
      canvasHeight: size.height,
      pixelScale,
    }
    options.onLayout?.({ ...layout })
    if (redrawIfPaused && !playing && lastError === undefined && (backResized || frontResized)) {
      runUpdate(timeMs, 0)
    }
  }

  function updatePointer(event: PointerEvent, downOverride?: boolean) {
    if (!pointerTracking) return
    const rect = stack.getBoundingClientRect()
    const down = downOverride !== undefined ? downOverride : (event.buttons & 1) !== 0
    pointer = mapClientToLogicalPointer(
      event.clientX,
      event.clientY,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      size.width,
      size.height,
      down,
    )
  }

  function setPointerTracking(enabled: boolean) {
    pointerTracking = Boolean(enabled)
    if (!pointerTracking) {
      pointer = { inside: false, down: false, x: size.width / 2, y: size.height / 2, nx: 0, ny: 0 }
    }
  }

  const onPointerMove = (e: PointerEvent) => updatePointer(e)
  const onPointerDown = (e: PointerEvent) => updatePointer(e, true)
  const onPointerUp = (e: PointerEvent) => updatePointer(e, false)
  const onPointerLeave = () => {
    pointer = { ...pointer, inside: false, down: false }
  }
  const onContextLost = (e: Event) => {
    e.preventDefault()
    pause()
    if (posterImg) {
      posterImg.style.display = 'block'
      puppet.canvas.style.display = 'none'
    }
    handleError(new Error('WebGL 上下文已丢失'))
  }

  box.addEventListener('pointermove', onPointerMove)
  box.addEventListener('pointerdown', onPointerDown)
  box.addEventListener('pointerup', onPointerUp)
  box.addEventListener('pointercancel', onPointerLeave)
  box.addEventListener('pointerleave', onPointerLeave)
  puppet.canvas.addEventListener('webglcontextlost', onContextLost)

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncLayout(true)) : undefined
  observer?.observe(box)

  function tick(wallTime: number) {
    if (!playing || disposed) return
    const rawDt = lastWallTime === undefined ? 0 : Math.min(100, Math.max(0, wallTime - lastWallTime))
    lastWallTime = wallTime
    const dtMs = rawDt * timeScale
    const ok = runUpdate(timeMs + dtMs, dtMs)
    if (playing && !disposed && (ok || (options.errorPolicy ?? 'pause') === 'throttle')) {
      frameId = requestAnimationFrame(tick)
    }
  }

  function play() {
    if (disposed || playing) return
    errorGate.clear()
    lastError = undefined
    playing = true
    lastWallTime = undefined
    frameId = requestAnimationFrame(tick)
  }

  function pause() {
    playing = false
    lastWallTime = undefined
    if (frameId !== undefined) {
      cancelAnimationFrame(frameId)
      frameId = undefined
    }
    emitFrame()
  }

  function resetInternal() {
    errorGate.clear()
    lastError = undefined
    timeMs = 0
    lastWallTime = undefined
    clearLayerSlot(backSlot, size.width, size.height)
    clearLayerSlot(frontSlot, size.width, size.height)
    instance.reset?.()
    puppet.reset()
    instance.setState?.(currentState)
  }

  function reset() {
    if (disposed) return
    try {
      resetInternal()
      runUpdate(0, 0)
    } catch (error) {
      handleError(error)
    }
  }

  function advanceBy(deltaMs: number) {
    if (disposed) return
    pause()
    let steps: ReturnType<typeof computeFixedSteps>
    try {
      steps = computeFixedSteps(deltaMs, stepMs)
    } catch (error) {
      handleError(error)
      return
    }
    const baseTime = timeMs
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      if (!runUpdate(baseTime + step.timeMs, step.dtMs, i === steps.length - 1)) return
    }
  }

  function stepTo(targetTimeMs: number) {
    if (disposed) return
    pause()
    try {
      computeFixedSteps(targetTimeMs, stepMs)
      resetInternal()
    } catch (error) {
      handleError(error)
      return
    }
    advanceBy(targetTimeMs)
  }

  function setPointer(next: Partial<LogicalPointer>) {
    if (disposed) return
    let x = pointer.x
    let y = pointer.y
    let nx = pointer.nx
    let ny = pointer.ny
    let inside = pointer.inside
    const down = next.down ?? pointer.down
    if (next.x !== undefined || next.y !== undefined) {
      x = next.x ?? x
      y = next.y ?? y
      nx = (x / size.width - 0.5) * 2
      ny = (y / size.height - 0.5) * 2
      inside = next.inside ?? (x >= 0 && x <= size.width && y >= 0 && y <= size.height)
    } else if (next.nx !== undefined || next.ny !== undefined) {
      nx = next.nx ?? nx
      ny = next.ny ?? ny
      x = (nx / 2 + 0.5) * size.width
      y = (ny / 2 + 0.5) * size.height
      inside = next.inside ?? (Math.abs(nx) <= 1 && Math.abs(ny) <= 1)
    } else if (next.inside !== undefined) {
      inside = next.inside
    }
    pointer = { inside, down, x, y, nx, ny }
  }

  function setState(nextState: string) {
    if (disposed) return
    currentState = nextState
    try {
      instance.setState?.(nextState)
      if (!playing) runUpdate(timeMs, 0)
    } catch (error) {
      handleError(error)
    }
  }

  function trigger(name: string, payload?: unknown) {
    if (disposed) return
    try {
      instance.trigger?.(name, payload)
      if (!playing) runUpdate(timeMs, 0)
    } catch (error) {
      handleError(error)
    }
  }

  function setTimeScale(scale: number) {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('timeScale 必须大于 0')
    timeScale = scale
  }

  function setViewport(nextViewport?: WorkViewportInput) {
    viewport = resolveViewport(nextViewport)
    syncLayout(true)
  }

  function destroy() {
    if (disposed) return
    disposed = true
    pause()
    observer?.disconnect()
    box.removeEventListener('pointermove', onPointerMove)
    box.removeEventListener('pointerdown', onPointerDown)
    box.removeEventListener('pointerup', onPointerUp)
    box.removeEventListener('pointercancel', onPointerLeave)
    box.removeEventListener('pointerleave', onPointerLeave)
    puppet.canvas.removeEventListener('webglcontextlost', onContextLost)
    try {
      instance.destroy?.()
    } finally {
      puppet.destroy()
      box.remove()
      if (posterBlobUrl) URL.revokeObjectURL(posterBlobUrl)
    }
  }

  // Initial sync & first frame
  syncLayout(false)
  try {
    instance.setState?.(currentState)
  } catch (error) {
    handleError(error)
  }
  runUpdate(0, 0)
  if (options.autoplay !== false && lastError === undefined) {
    play()
  }

  return {
    element: box,
    stackElement: stack,
    puppet,
    meta,
    get playing() {
      return playing
    },
    get pointerTracking() {
      return pointerTracking
    },
    get timeMs() {
      return timeMs
    },
    get state() {
      return currentState
    },
    get pointer() {
      return { ...pointer }
    },
    get lastError() {
      return lastError
    },
    play,
    pause,
    setPointerTracking,
    setValidateGeometry(enabled: boolean) {
      puppet.setValidateGeometry(enabled)
    },
    setTimeScale,
    advanceBy,
    stepTo,
    reset,
    setPointer,
    setState,
    trigger,
    setViewport,
    getLayout: () => ({ ...layout }),
    destroy,
  }
}
