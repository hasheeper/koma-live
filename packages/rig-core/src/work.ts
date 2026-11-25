import { z } from 'zod'

const id = z.string().min(1)

export const viewportSchema = z.strictObject({
  fit: z.enum(['contain', 'cover']).default('contain'),
  anchor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.5, 0.5]),
  paddingPx: z.number().nonnegative().default(0),
})
export type WorkViewport = z.infer<typeof viewportSchema>
export const viewportInputSchema = viewportSchema.partial()
export type WorkViewportInput = z.infer<typeof viewportInputSchema>

export const workManifestSchema = z.strictObject({
  format: z.literal('koma-rig.work.v1'),
  id,
  title: z.string().min(1).optional(),
  rig: z.string().min(1),
  performance: z.string().min(1).optional(),
  poster: z.string().min(1).optional(),
  viewport: viewportInputSchema.optional(),
  defaultState: id.optional(),
})
export type WorkManifest = z.infer<typeof workManifestSchema>

export const performanceMetaSchema = z.strictObject({
  format: z.literal('koma-rig.performance.v1'),
  title: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  states: z.array(id).optional(),
  triggers: z.array(id).optional(),
  layers: z
    .strictObject({
      back: z.union([z.literal('2d'), z.literal(false)]).optional(),
      front: z.union([z.literal('2d'), z.literal(false)]).optional(),
    })
    .optional(),
})
export type PerformanceMeta = z.infer<typeof performanceMetaSchema>

export interface ViewportLayout {
  scale: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

export interface LogicalPointer {
  inside: boolean
  down: boolean
  x: number
  y: number
  nx: number
  ny: number
}

export interface FixedTimeStep {
  timeMs: number
  dtMs: number
}

export type PerformanceErrorPolicy = 'pause' | 'throttle'

/** Resolve partial viewport input into validated defaults. */
export function resolveViewport(input?: WorkViewportInput): WorkViewport {
  return viewportSchema.parse(input ?? {})
}

/** Compute uniform scale and anchor-aligned offset inside a container. */
export function computeViewportLayout(
  containerWidth: number,
  containerHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  input?: WorkViewportInput,
): ViewportLayout {
  if (!(canvasWidth > 0 && canvasHeight > 0)) throw new Error('画布尺寸必须大于 0')
  const { fit, anchor, paddingPx } = resolveViewport(input)
  const availW = Math.max(0, containerWidth - paddingPx * 2)
  const availH = Math.max(0, containerHeight - paddingPx * 2)
  if (availW <= 0 || availH <= 0) {
    return { scale: 0, offsetX: paddingPx, offsetY: paddingPx, width: 0, height: 0 }
  }
  const sx = availW / canvasWidth
  const sy = availH / canvasHeight
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
  const width = canvasWidth * scale
  const height = canvasHeight * scale
  return {
    scale,
    offsetX: paddingPx + (availW - width) * anchor[0],
    offsetY: paddingPx + (availH - height) * anchor[1],
    width,
    height,
  }
}

/** Map client/screen coordinates back into manifest.canvas logical pixels. */
export function mapClientToLogicalPointer(
  clientX: number,
  clientY: number,
  stackLeft: number,
  stackTop: number,
  stackWidth: number,
  stackHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  down: boolean,
): LogicalPointer {
  if (!(stackWidth > 0 && stackHeight > 0 && canvasWidth > 0 && canvasHeight > 0)) {
    return { inside: false, down, x: 0, y: 0, nx: 0, ny: 0 }
  }
  const x = ((clientX - stackLeft) / stackWidth) * canvasWidth
  const y = ((clientY - stackTop) / stackHeight) * canvasHeight
  const inside = x >= 0 && x <= canvasWidth && y >= 0 && y <= canvasHeight
  return {
    inside,
    down,
    x,
    y,
    nx: (x / canvasWidth - 0.5) * 2,
    ny: (y / canvasHeight - 0.5) * 2,
  }
}

/**
 * Compute backing-store pixel scale for 2D coaxial back/front layers.
 * Keeps crisp Retina rendering while bounding memory by maxDpr and maxSidePx.
 */
export function computeLayerPixelScale(
  devicePixelRatio: number,
  displayScale: number,
  canvasWidth: number,
  canvasHeight: number,
  maxDpr = 2,
  maxSidePx = 4096,
  resolutionScale = 1,
): number {
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const safeDisplay = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1
  const safeCap = Number.isFinite(maxDpr) && maxDpr >= 1 ? maxDpr : 1
  const safeRes =
    Number.isFinite(resolutionScale) && resolutionScale > 0 ? Math.min(1, resolutionScale) : 1
  const maxSide = Math.max(canvasWidth, canvasHeight)
  const sideCap = maxSide > 0 && maxSidePx > 0 ? Math.max(1, maxSidePx / maxSide) : safeCap
  const desired = Math.max(1, safeDpr * safeDisplay)
  return Math.min(desired, safeCap, sideCap) * safeRes
}

/** Generate deterministic fixed-step increments from 0 to targetTimeMs for stepTo(). */
export function computeFixedSteps(targetTimeMs: number, stepMs = 10): FixedTimeStep[] {
  if (!Number.isFinite(targetTimeMs) || targetTimeMs < 0) throw new Error('目标时间必须为非负有限数')
  if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error('步长必须为正数')
  if (targetTimeMs === 0) return [{ timeMs: 0, dtMs: 0 }]
  const count = Math.floor(targetTimeMs / stepMs)
  const steps: FixedTimeStep[] = []
  for (let i = 1; i <= count; i++) {
    steps.push({ timeMs: i * stepMs, dtMs: stepMs })
  }
  const covered = count * stepMs
  const remainder = targetTimeMs - covered
  if (remainder > 1e-9) {
    steps.push({ timeMs: targetTimeMs, dtMs: remainder })
  }
  return steps
}

/** Error storm protection gate: auto-pause or signature-deduplicated throttle. */
export function createErrorGate(policy: PerformanceErrorPolicy = 'pause', throttleMs = 1000) {
  let paused = false
  let lastSignature: string | undefined
  let lastNotifiedAt = -Infinity

  function signature(error: unknown) {
    if (error instanceof Error) return `${error.name}:${error.message}`
    return String(error)
  }

  return {
    report(error: unknown, nowMs: number): { notify: boolean; shouldPause: boolean } {
      if (policy === 'pause') {
        if (paused) return { notify: false, shouldPause: true }
        paused = true
        lastSignature = signature(error)
        lastNotifiedAt = nowMs
        return { notify: true, shouldPause: true }
      }
      const sig = signature(error)
      const windowMs = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : 1000
      if (sig === lastSignature && nowMs - lastNotifiedAt < windowMs) {
        return { notify: false, shouldPause: false }
      }
      lastSignature = sig
      lastNotifiedAt = nowMs
      return { notify: true, shouldPause: false }
    },
    clear() {
      paused = false
      lastSignature = undefined
      lastNotifiedAt = -Infinity
    },
  }
}

/**
 * Guard against external ESM imports in single-file standalone performance scripts (Guardrail 1).
 * Replaces comments with spaces and string literals with empty quotes in one pass so string
 * contents never trigger false positives while real import/export-from statements are caught.
 */
export function assertStandalonePerformanceSource(source: string) {
  const scrubbed = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => (match.startsWith('/') ? ' ' : '""'),
  )
  if (
    /(^|[;\n])\s*import\s+(?:[\s\S]*?\s+from\s+)?""/m.test(scrubbed) ||
    /(^|[;\n])\s*export\s+(?:\*|\{[^}]*\})\s+from\s+""/m.test(scrubbed) ||
    /\bimport\s*\(/.test(scrubbed)
  ) {
    throw new Error(
      '演出脚本必须为单文件自包含 ES Module，不支持外部 import / export-from / 动态 import()，请内联依赖或打包为单文件',
    )
  }
}
