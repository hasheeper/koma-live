import { createRig } from './pose.js'
import { sliceManifestSchema, type PixelRect, type SliceManifest } from './slices.js'
import { transform } from './skeleton.js'

export interface LayerPixelMetrics {
  /** Canvas-space bounding box of non-transparent pixels `[minX, minY, maxX, maxY]`. */
  alphaRect: PixelRect
  /** Median canvas pixel of the topmost non-transparent band `[x, y]`. */
  topRoot?: readonly [number, number]
}

export interface DiagnoseRigOptions {
  /** Optional per-layer painted alpha metrics (canvas space), typically supplied by CLI tooling. */
  pixelMetrics?: Record<string, LayerPixelMetrics>
  /** Rest alignment drift threshold in pixels for warnings (default `0.25`). */
  restWarnPx?: number
  /** Rest alignment drift threshold in pixels for errors (default `1.0`). */
  restErrorPx?: number
  /** Distance threshold from bone `restStart` outside a slice's alpha bounds to flag (default `80`). */
  pivotOutsidePx?: number
}

export interface RigDiagnosticIssue {
  severity: 'error' | 'warning' | 'info'
  code:
    | 'rest_drift'
    | 'mesh_origin_mismatch'
    | 'pivot_far_from_layer'
    | 'shadow_order_conflict'
    | 'head_calibration_missing'
  layerId?: string
  boneId?: string
  message: string
  metrics?: Record<string, number | string | number[]>
}

export interface RigDiagnosisReport {
  ok: boolean
  summary: {
    layers: number
    bones: number
    bindings: number
    morphs: number
    maxRestDriftPx: number
    errors: number
    warnings: number
    infos: number
  }
  issues: RigDiagnosticIssue[]
}

const round3 = (n: number) => Number(n.toFixed(3))

function pointToRectDistance(px: number, py: number, rect: PixelRect): number {
  const [x, y, w, h] = rect
  const dx = px < x ? x - px : px > x + w ? px - (x + w) : 0
  const dy = py < y ? y - py : py > y + h ? py - (y + h) : 0
  return Math.hypot(dx, dy)
}

/**
 * Pure-ECMAScript static & rest-pose structural audit for a Koma Rig project.
 * Catches restOffset/bindOrigin drift, off-root bone pivots, and cast-shadow draw-order conflicts.
 */
export function diagnoseRig(
  manifestInput: SliceManifest | unknown,
  rawRig: unknown,
  options: DiagnoseRigOptions = {},
): RigDiagnosisReport {
  const manifest = sliceManifestSchema.parse(manifestInput)
  const model = createRig(manifest, rawRig)
  const restPose = model.pose()
  const restWarnPx = options.restWarnPx ?? 0.25
  const restErrorPx = options.restErrorPx ?? 1.0
  const pivotOutsidePx = options.pivotOutsidePx ?? 80

  const issues: RigDiagnosticIssue[] = []
  const layerById = new Map(manifest.layers.map((l) => [l.layerId, l]))
  const bindingById = new Map(model.bindings.map((b) => [b.layerId, b]))
  const drawIndex = new Map(restPose.parts.map((p, i) => [p.layerId, i]))

  // Count total references to each bone across both single-bone and chain bindings, plus child-bone presence.
  // Structural/limb container bones (shared across chains or owning child bones) legitimately host distal accessories.
  const boneUsageCount = new Map<string, number>()
  for (const b of model.bindings) {
    if (b.boneId) boneUsageCount.set(b.boneId, (boneUsageCount.get(b.boneId) ?? 0) + 1)
    for (const cid of b.boneChain ?? []) {
      boneUsageCount.set(cid, (boneUsageCount.get(cid) ?? 0) + 1)
    }
  }
  const hasChildBone = new Set<string>()
  for (const bone of model.skeleton.byId.values()) {
    if (bone.parentBoneId) hasChildBone.add(bone.parentBoneId)
  }

  let maxRestDriftPx = 0

  for (const part of restPose.parts) {
    const layer = layerById.get(part.layerId)
    if (!layer) continue
    const [rx, ry, rw, rh] = layer.rect

    // 1. Rest-pose pixel alignment drift (detects forgotten restOffset/bindOrigin compensation after padding/re-slicing!)
    let layerDrift = 0
    if (part.geometry) {
      const verts = part.geometry.vertices
      const uvs = part.geometry.uv
      for (let i = 0; i < verts.length; i += 2) {
        const [wx, wy] = transform(part.matrix, verts[i]!, verts[i + 1]!)
        const expectedX = rx + uvs[i]! * rw
        const expectedY = ry + uvs[i + 1]! * rh
        layerDrift = Math.max(layerDrift, Math.hypot(wx - expectedX, wy - expectedY))
      }
    } else {
      const corners: [number, number][] = [
        [0, 0],
        [rw, 0],
        [0, rh],
        [rw, rh],
      ]
      for (const [lx, ly] of corners) {
        const [wx, wy] = transform(part.matrix, lx, ly)
        layerDrift = Math.max(layerDrift, Math.hypot(wx - (rx + lx), wy - (ry + ly)))
      }
    }
    maxRestDriftPx = Math.max(maxRestDriftPx, layerDrift)

    if (layerDrift > restWarnPx) {
      const severity = layerDrift >= restErrorPx ? 'error' : 'warning'
      issues.push({
        severity,
        code: 'rest_drift',
        layerId: layer.layerId,
        boneId: bindingById.get(layer.layerId)?.boneId,
        message: `图层 ${layer.layerId} 在静止姿态偏移 ${round3(layerDrift)} px（检查 restOffset / bindOrigin / mesh.points 是否与切片 rect 同步）`,
        metrics: { driftPx: round3(layerDrift), rect: [...layer.rect] },
      })
    }

    // 1b. Mesh bindOrigin mismatch check (expanding/cropping a meshed slice without shifting mesh.points clips pixels!)
    const binding = bindingById.get(layer.layerId)
    if (binding?.mesh && binding.bindOrigin) {
      const originShift = Math.hypot(binding.bindOrigin[0] - rx, binding.bindOrigin[1] - ry)
      if (originShift > restErrorPx) {
        issues.push({
          severity: 'error',
          code: 'mesh_origin_mismatch',
          layerId: layer.layerId,
          message: `网格图层 ${layer.layerId} 的 bindOrigin [${binding.bindOrigin[0]}, ${binding.bindOrigin[1]}] 与切片原点 [${rx}, ${ry}] 偏差 ${round3(originShift)} px，未同步 mesh.points 会裁切贴图（请使用 rig pad-slice / syncSliceBinding）`,
          metrics: { originShiftPx: round3(originShift), bindOrigin: [...binding.bindOrigin], rectOrigin: [rx, ry] },
        })
      }
    }

    // 2. Dedicated single-bone leaf pivot sanity check (detects off-root leaf bone pivots that orbit slices!)
    if (
      binding?.boneId &&
      !binding.boneChain &&
      (boneUsageCount.get(binding.boneId) ?? 0) === 1 &&
      !hasChildBone.has(binding.boneId)
    ) {
      const bonePose = model.skeleton.rest.get(binding.boneId)
      if (bonePose) {
        const [bx, by] = bonePose.start
        const pix = options.pixelMetrics?.[layer.layerId]
        const refRect = pix?.alphaRect ?? layer.rect
        const outsideDist = pointToRectDistance(bx, by, refRect)
        const topDist = pix?.topRoot ? Math.hypot(bx - pix.topRoot[0], by - pix.topRoot[1]) : undefined
        if (outsideDist > pivotOutsidePx) {
          issues.push({
            severity: 'warning',
            code: 'pivot_far_from_layer',
            layerId: layer.layerId,
            boneId: binding.boneId,
            message: `专属骨骼 ${binding.boneId} 枢轴 [${round3(bx)}, ${round3(by)}] 偏离图层 ${layer.layerId} 区域 ${round3(outsideDist)} px，旋转时易整体公转飞离（可用 rig repivot 修正）`,
            metrics: {
              pivot: [round3(bx), round3(by)],
              outsideDistPx: round3(outsideDist),
              ...(topDist !== undefined ? { topRootDistPx: round3(topDist) } : {}),
            },
          })
        }
      }
    }
  }

  // 3. Static castShadow draw-order conflicts (caster rendered behind receiver!)
  for (const shadow of restPose.shadows ?? []) {
    for (const caster of shadow.casters) {
      const ci = drawIndex.get(caster)
      if (ci === undefined) continue
      for (const receiver of shadow.receivers) {
        const ri = drawIndex.get(receiver)
        if (ri === undefined) continue
        if (ci < ri) {
          issues.push({
            severity: 'warning',
            code: 'shadow_order_conflict',
            layerId: caster,
            message: `投影源 ${caster}（绘制序 #${ci}）位于接收层 ${receiver}（绘制序 #${ri}）之后，投射阴影可能错位或多余`,
            metrics: { casterIndex: ci, receiverIndex: ri, receiver },
          })
        }
      }
    }
  }

  // 4. Head calibration single-source check
  const rawObj = (rawRig && typeof rawRig === 'object' ? rawRig : {}) as { morphs?: { axes?: unknown[] }[] }
  const morphCount = Array.isArray(rawObj.morphs) ? rawObj.morphs.length : 0
  const has2DMorphs = Array.isArray(rawObj.morphs) && rawObj.morphs.some((m) => Array.isArray(m.axes) && m.axes.length === 2)
  if (has2DMorphs && !model.headCalibration) {
    issues.push({
      severity: 'info',
      code: 'head_calibration_missing',
      message: '已包含二维头部 Morph，但 rig.json 尚未记录 headCalibration 元数据（重新执行 rig auto-head 即可自动写入供脚本直读）',
    })
  }

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.filter((i) => i.severity === 'warning').length
  const infos = issues.filter((i) => i.severity === 'info').length

  return {
    ok: errors === 0,
    summary: {
      layers: manifest.layers.length,
      bones: model.skeleton.byId.size,
      bindings: model.bindings.length,
      morphs: morphCount,
      maxRestDriftPx: round3(maxRestDriftPx),
      errors,
      warnings,
      infos,
    },
    issues,
  }
}
