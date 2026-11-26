import { z } from 'zod'
import { point, type Point } from './geometry.js'
import { MAX_FIELD_GRID } from './mesh-field.js'
import type { LayerMorphGrid } from './morph.js'
import type { SliceManifest } from './slices.js'

const id = z.string().min(1)
const divisions = z.int().min(1).max(MAX_FIELD_GRID)
const angle = z.number().positive().lt(45)
const rect = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
const roleSchema = z.enum(['face', 'crown', 'sideburn', 'front_bang', 'ahoge', 'ear', 'accessory', 'horn', 'back_hair'])

const layerSchema = z.strictObject({
  role: roleSchema,
  grid: z.tuple([divisions, divisions]).optional(),
  zRatio: z.number().optional(),
  rootZRatio: z.number().optional(),
  tipZRatio: z.number().optional(),
  outerZRatio: z.number().optional(),
  pitchScale: z.number().min(0).max(1.5).optional(),
  followPoint: point.optional(),
  eyePairCenters: z.tuple([point, point]).optional(),
})

const adjustmentSchema = z.strictObject({
  left: point.optional(),
  right: point.optional(),
  up: point.optional(),
  down: point.optional(),
  leftUp: point.optional(),
  rightUp: point.optional(),
  leftDown: point.optional(),
  rightDown: point.optional(),
})

export const autoHeadConfigSchema = z.strictObject({
  format: z.literal('koma-rig.auto-head.v1'),
  parameters: z
    .strictObject({
      yaw: z.strictObject({ id, deg: angle }).optional(),
      pitch: z.strictObject({ id, upDeg: angle, downDeg: angle }).optional(),
    })
    .optional(),
  geometry: z.strictObject({
    faceLayer: id,
    faceBox: rect.optional(),
    faceCenterX: z.number().optional(),
    neckAnchor: point.optional(),
    pinNeck: z.boolean().default(false),
    eyeCenters: z.tuple([point, point]).optional(),
    headDepthRatio: z.number().positive().default(0.30),
    skullSwingRatio: z.number().min(0).max(0.5).default(0),
    faceRelief: z.number().min(0).max(1.5).default(0),
    crownDome: z.number().min(0).max(1.5).default(0),
    belowNeckFadePx: z.number().positive().optional(),
  }),
  layers: z.record(id, layerSchema),
  adjustments: z.record(id, adjustmentSchema).optional(),
})

export const headCalibrationSchema = z.strictObject({
  faceLayer: id,
  center: point,
  neckAnchor: point,
  pinNeck: z.boolean(),
  yaw: z.strictObject({ id, deg: angle }),
  pitch: z.strictObject({ id, upDeg: angle, downDeg: angle }),
  headDepthRatio: z.number().positive(),
  skullSwingRatio: z.number().min(0).max(0.5),
})
export type HeadCalibration = z.infer<typeof headCalibrationSchema>

export type AutoHeadConfig = z.infer<typeof autoHeadConfigSchema>
export type AutoHeadLayerRole = z.infer<typeof roleSchema>
type LayerCfg = z.infer<typeof layerSchema>
type Rect = z.infer<typeof rect>

// Bounded depth offsets relative to the 3D skull shell (multiples of face half-width rx).
// t = 0 is the top of the slice rect and t = 1 is the bottom of the slice rect.
const ROLE_DEPTH: Record<AutoHeadLayerRole, [number, number]> = {
  face: [0, 0],
  crown: [0.025, 0.03],
  sideburn: [0.025, 0.06],
  front_bang: [0.035, 0.16],
  ahoge: [0.03, 0.03],
  ear: [-0.16, -0.16],
  accessory: [-0.10, -0.10],
  horn: [-0.02, -0.44],
  back_hair: [-0.24, -0.24],
}

const POSES = ['leftUp', 'up', 'rightUp', 'left', 'center', 'right', 'leftDown', 'down', 'rightDown'] as const
const RAD = Math.PI / 180

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t)
const smoothstep = (t: number) => {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}
const round4 = (n: number) => (Math.round(n * 1e4) + 0) / 1e4

/** Reconstruct the piecewise-affine triangle surface rendered by a regular morph lattice. */
function sampleLattice(grid: Point, bounds: Rect, delta: number[], x: number, y: number): Point {
  const [cols, rows] = grid
  const u = clamp01((x - bounds[0]) / bounds[2]) * cols
  const v = clamp01((y - bounds[1]) / bounds[3]) * rows
  const i = Math.min(cols - 1, Math.floor(u))
  const j = Math.min(rows - 1, Math.floor(v))
  const a = u - i
  const b = v - j
  const stride = (cols + 1) * 2
  const k = j * stride + i * 2
  const weights = a + b <= 1 ? [1 - a - b, a, b, 0] : [0, 1 - b, 1 - a, a + b - 1]
  const indices = [k, k + 2, k + stride, k + stride + 2]
  let dx = 0
  let dy = 0
  for (let m = 0; m < 4; m++) {
    dx += weights[m]! * delta[indices[m]!]!
    dy += weights[m]! * delta[indices[m]! + 1]!
  }
  return [dx, dy]
}

/** Exact minimum corner Jacobian across every cell of a regular morph lattice. */
function minLatticeJacobian(grid: Point, bounds: Rect, d: number[]) {
  const [cols, rows] = grid
  const stride = (cols + 1) * 2
  const cellW = bounds[2] / cols
  const cellH = bounds[3] / rows
  let minJ = Infinity
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * stride + i * 2
      for (const row of [k, k + stride]) {
        for (const col of [k, k + 2]) {
          const dxdx = 1 + (d[row + 2]! - d[row]!) / cellW
          const dydx = (d[row + 3]! - d[row + 1]!) / cellW
          const dxdy = (d[col + stride]! - d[col]!) / cellH
          const dydy = 1 + (d[col + stride + 1]! - d[col + 1]!) / cellH
          minJ = Math.min(minJ, dxdx * dydy - dxdy * dydx)
        }
      }
    }
  }
  return minJ
}

/** Remove the bilinear twist in the single cell containing the neck anchor so both triangle splits agree. */
function pinAnchorCell(grid: Point, bounds: Rect, d: number[], anchor: Point): Point | null {
  const [cols, rows] = grid
  const u = ((anchor[0] - bounds[0]) / bounds[2]) * cols
  const v = ((anchor[1] - bounds[1]) / bounds[3]) * rows
  if (u < 0 || u > cols || v < 0 || v > rows) return null
  const i = Math.min(cols - 1, Math.floor(u))
  const j = Math.min(rows - 1, Math.floor(v))
  const tx = u - i
  const ty = v - j
  const stride = (cols + 1) * 2
  const k00 = j * stride + i * 2
  const k10 = k00 + 2
  const k01 = k00 + stride
  const k11 = k01 + 2
  const onEdge = tx <= 1e-6 || tx >= 1 - 1e-6 || ty <= 1e-6 || ty >= 1 - 1e-6
  const out: Point = [0, 0]
  for (const axis of [0, 1] as const) {
    if (!onEdge) {
      const twist = (d[k00 + axis]! - d[k10 + axis]! - d[k01 + axis]! + d[k11 + axis]!) / 4
      d[k00 + axis] = d[k00 + axis]! - twist
      d[k11 + axis] = d[k11 + axis]! - twist
      d[k10 + axis] = d[k10 + axis]! + twist
      d[k01 + axis] = d[k01 + axis]! + twist
    }
    out[axis] =
      (1 - ty) * ((1 - tx) * d[k00 + axis]! + tx * d[k10 + axis]!) +
      ty * ((1 - tx) * d[k01 + axis]! + tx * d[k11 + axis]!)
  }
  return out
}

/**
 * Generate clean 9-pose (3x3 Yaw x Pitch) head morphs using a Pro-Live2D volumetric 3D skull model:
 * 1) Coaxial 3D midline glide (forehead -> eyes -> nose -> mouth -> chin) with rounded near cheek
 *    and subtle 3/4 far-cheek sculpting (zero chin-pinned parallelogram shear or squeezed-card look).
 * 2) Broad, gentle 3D Pitch dome that lifts/drops the entire face smoothly with ~1px natural eye-line
 *    arch (zero diagonal caret eye-bending or outer-corner plunge on UR/UL/DR/DL!).
 * 3) Direct column-sampled paired expression eyes (zero tangent extrapolation overshoot, ∂y'/∂y === 1)
 *    and temple-anchored volume-preserving sideburns (zero accordion crush).
 */
export function buildAutoHeadMorphs(manifest: SliceManifest, input: unknown) {
  const cfg = autoHeadConfigSchema.parse(input)
  const g = cfg.geometry
  const slices = new Map(manifest.layers.map((l) => [l.layerId, l.rect]))
  const faceRect = slices.get(g.faceLayer)
  if (!faceRect) throw new Error('未知脸部图层 ' + g.faceLayer)

  const [fx, fy, fw, fh] = g.faceBox ?? faceRect
  const rx = fw / 2
  const ry = fh / 2
  const cx = g.faceCenterX ?? fx + rx
  const cy = fy + 0.52 * fh
  const chinY = fy + fh
  const neck: Point = g.neckAnchor ?? [cx, chinY]
  const pinNeck = g.pinNeck
  const belowNeckFadePx = g.belowNeckFadePx ?? (pinNeck ? 0.42 * fh : 0.72 * fh)
  const yaw = cfg.parameters?.yaw ?? { id: 'headYaw', deg: 13.5 }
  const pitch = cfg.parameters?.pitch ?? { id: 'headPitch', upDeg: 9.5, downDeg: 11.5 }
  if (yaw.id === pitch.id) throw new Error('左右转头和俯仰需要不同参数')

  const layers: Record<string, LayerCfg> = { [g.faceLayer]: { role: 'face' }, ...cfg.layers }
  const faceCfg = layers[g.faceLayer]!
  if (faceCfg.role !== 'face' || faceCfg.followPoint || faceCfg.eyePairCenters) {
    throw new Error('脸底必须使用共享 face 曲面')
  }
  for (const name of Object.keys(cfg.adjustments ?? {})) {
    if (!Object.hasOwn(layers, name)) throw new Error('未知微调图层 ' + name)
  }
  for (const [name, l] of Object.entries(layers)) {
    if (!slices.has(name)) throw new Error('未知头部图层 ' + name)
    if (l.eyePairCenters) {
      const [a, b] = l.eyePairCenters
      const [lx, ly, lw, lh] = slices.get(name)!
      if (
        l.role !== 'face' ||
        l.followPoint ||
        a[0] >= b[0] ||
        [a, b].some((p) => p[0] < lx || p[0] > lx + lw || p[1] < ly || p[1] > ly + lh)
      ) {
        throw new Error('双眼锚点须从左到右位于同一 face 表情切片内 ' + name)
      }
    }
  }

  const faceGrid: Point = faceCfg.grid ?? [12, 10]
  const eyeCenters = g.eyeCenters ?? Object.values(layers).find((l) => l.eyePairCenters)?.eyePairCenters
  if (eyeCenters && eyeCenters[0][0] >= eyeCenters[1][0]) throw new Error('双眼锚点须从左到右排列')

  const rz = rx * g.headDepthRatio
  const uBound = 1.25
  const vBound = 1.35
  const faceRelief = g.faceRelief
  const crownDome = g.crownDome
  const symEyeSpan = eyeCenters ? Math.abs(eyeCenters[1][0] - eyeCenters[0][0]) / 2 : 0.44 * rx
  const symEyeY = eyeCenters ? (eyeCenters[0][1] + eyeCenters[1][1]) / 2 : cy + 0.08 * ry
  const eyeReliefRx = Math.max(0.24 * rx, symEyeSpan * 0.56)
  const eyeReliefRy = 0.24 * ry

  const boundedU = (x: number) => uBound * Math.tanh((x - cx) / rx / uBound)
  const boundedV = (y: number) => vBound * Math.tanh((y - cy) / ry / vBound)

  function belowNeckAttenuation(y: number) {
    if (y <= neck[1]) return 1
    const s = smoothstep((y - neck[1]) / belowNeckFadePx)
    return pinNeck ? 1 - s : 1 - 0.55 * s
  }

  function makeField(ix: number, iy: number) {
    const yawRad = ix * yaw.deg * RAD
    const pitchRad = iy < 0 ? -pitch.upDeg * RAD : iy > 0 ? pitch.downDeg * RAD : 0
    const cosY = Math.cos(yawRad)
    const sinY = Math.sin(yawRad)
    const cosP = Math.cos(pitchRad)
    const sinP = Math.sin(pitchRad)
    const signY = ix === 0 ? 0 : Math.sign(ix)
    const yawMag = Math.abs(sinY) / Math.sin(13.5 * RAD)

    function evalCore(x: number, y: number, role: AutoHeadLayerRole, l: LayerCfg, t: number): Point {
      const u = (x - cx) / rx
      const uc = boundedU(x)
      const vc = boundedV(y)
      const u2 = uc * uc
      const dv = vc - 0.16
      const isHairShell = role === 'crown' || role === 'front_bang' || role === 'sideburn' || role === 'ahoge'
      const isHorn = role === 'horn'
      const isRearMount = role === 'ear' || role === 'accessory' || role === 'back_hair'

      // 0. True 3D spherical cranium coordinates centered at the skull dome (above eyes, matching crown radius):
      //    sx = ±1 at left/right temple silhouette; sy = -1 at topmost scalp pole, 0 at brow/temple equator!
      const skullCy = fy + 0.34 * fh
      const skullRy = 1.62 * ry
      const sx = (x - cx) / (1.30 * rx)
      const sy = (y - skullCy) / skullRy

      // 0b. Rigid 3D stone-horn projection bolted behind the skull temples (ZERO rubber shear or head fusion!):
      //     Entire horn + horn_base obeys one cohesive rigid 3D rotation around the cranium center (cx, skullCy, 0)
      //     with monotonic behind-temple depth (z <= 0) + true weak-perspective camera foreshortening:
      //     - Yaw: far horn tucks cleanly BEHIND the round crown & shrinks; near horn opens forward & grows!
      //     - Pitch DOWN: tall horn tips tower UP & forward over the skull; Pitch UP: tips tilt back behind head!
      if (isHorn) {
        const [defRoot, defOuter] = ROLE_DEPTH.horn
        const zRootRatio = l.rootZRatio ?? defRoot
        const zOuterRatio = l.outerZRatio ?? defOuter

        const absU = Math.abs(u)
        const outT = smoothstep((absU - 0.92) / 1.45)
        const zRatio = zRootRatio + (zOuterRatio - zRootRatio) * outT * 0.65
        // Monotonic behind-skull depth (clamped <= 0 when negative so root & tip NEVER move in opposite directions!)
        const rxH = x - cx
        const ryH = y - skullCy
        const rzH = rx * zRatio

        // Exact 3D rigid rotation: Yaw around Y, then Pitch around X
        const x1 = rxH * cosY + rzH * sinY
        const z1 = -rxH * sinY + rzH * cosY
        const y2 = ryH * cosP + z1 * sinP
        const z2 = -ryH * sinP + z1 * cosP

        // Subtle anime-calibrated weak camera perspective (focal ~ 9.5*rx) for unmistakable near/far depth hierarchy
        const dzPersp = Math.max(-2.6 * rx, Math.min(2.6 * rx, z2 - rzH))
        const pScale = 1 / (1 - dzPersp / (9.5 * rx))
        const dxRigid = x1 * pScale - rxH
        const dyRigid = y2 * pScale - ryH

        // Dampen extreme distant tips softly only if far outside head bounds so lattice Jacobian stays rock solid
        const rawHHorn = Math.max(0, (neck[1] - y) / fh)
        const swingXHorn = g.skullSwingRatio > 0 ? rx * g.skullSwingRatio * sinY * smoothstep(rawHHorn / 0.92) : 0

        return [
          dxRigid + swingXHorn,
          dyRigid * (l.pitchScale ?? 1),
        ]
      }

      // 1. Longitudinal 3D face glide vs true 3D spherical cranium hair dome:
      //    Face egg keeps eyes un-stretched & cheeks round; cranium hair shell stays ROUND at its outer silhouette
      //    (a sphere's 2D silhouette is NEVER sliced flat!) while its interior surface (whorl, parting, bangs root)
      //    glides smoothly across the curved 3D spherical dome in BOTH Yaw and Pitch!
      const mhFace = Math.exp(-0.36 * u2 - 1.75 * u2 * u2)
      const mvFace = 0.26 + 0.74 * Math.exp(-0.44 * dv * dv)

      const sxC = 1.35 * Math.tanh(sx / 1.35)
      const syTop = Math.min(0, sy) // negative above brow/temple equator
      const syBot = Math.max(0, sy) // positive below brow/temple equator
      const mhHair = Math.exp(-0.62 * sxC * sxC - 0.65 * Math.pow(sxC, 4))
      const mvTopDomeBase = Math.exp(-0.95 * syTop * syTop - 0.28 * Math.pow(syTop, 4))
      const domeMix = Math.min(1, crownDome) * 0.68
      const rDome2 = Math.min(0.94, sxC * sxC * 0.74 + syTop * syTop * 0.74)
      const sphereTopH = Math.sqrt(Math.max(0.06, 1 - rDome2))
      const mvTopDome = domeMix > 0 ? mvTopDomeBase * (1 - domeMix) + sphereTopH * domeMix : mvTopDomeBase
      const mvBotDome = 0.34 + 0.66 * Math.exp(-0.38 * syBot * syBot)
      const mvHair = sy < 0 ? mvTopDome : mvBotDome

      const mh = isHairShell ? mhHair : mhFace
      const mv = isHairShell ? mvHair : mvFace

      // 2. Bounded cosine foreshortening:
      //    Keep outer skull silhouette gracefully round (NEVER chop half the head off on turns!);
      //    far side foreshortens cleanly without colliding into the far eye.
      const us = u * Math.exp(-0.46 * u * u)
      const farU = signY * u
      const uCosHair = 1.85 * Math.tanh(u / 1.85)
      const hairFarCosW = 0.22 + 0.78 * smoothstep((farU + 0.25) / 0.90)
      const dxCos = isHairShell
        ? uCosHair * rx * (cosY - 1) * hairFarCosW * (0.65 + 0.35 * mvHair)
        : isRearMount
          ? uCosHair * rx * (cosY - 1) * 0.78
          : us * rx * (cosY - 1) * (0.45 + 0.55 * mvFace)

      // 3. 3/4 far-cheek & far-side contour sculpt: gentle anime cheek curve (never crushes far eye!)
      const depthGain = Math.max(1, g.headDepthRatio / 0.30)
      const cheekBand =
        !isHairShell && !isRearMount && farU > 0
          ? Math.exp(-Math.pow((farU - 0.88) / 0.36, 2)) * Math.exp(-Math.pow((vc - 0.30) / 0.72, 2))
          : 0
      const dxCheek = -signY * rx * 0.022 * depthGain * (1 + 0.25 * faceRelief) * yawMag * cheekBand

      // Gentle spherical edge wrap on far crown (kept strictly subtle so the anime head stays round!)
      const farCrownBand =
        isHairShell && farU > 0.35
          ? smoothstep((farU - 0.35) / 0.95) * (0.45 + 0.55 * mvHair)
          : 0
      const dxCrownFarTuck = -signY * rx * 0.028 * (depthGain - 1) * yawMag * farCrownBand

      // 3b. Refined 3D facial relief heightfield (smooth concave eye-socket bowls + protruding nose bridge,
      //     brow ridge, plump 3/4 cheeks & lips — calibrated to preserve crisp 2D anime lineart & Jacobian >= 0.55!).
      let zFaceRelief = 0
      if (faceRelief > 0 && !isHairShell && !isRearMount) {
        const orbitL = Math.exp(
          -Math.pow((x - (cx - symEyeSpan)) / eyeReliefRx, 2) - Math.pow((y - symEyeY) / eyeReliefRy, 2),
        )
        const orbitR = Math.exp(
          -Math.pow((x - (cx + symEyeSpan)) / eyeReliefRx, 2) - Math.pow((y - symEyeY) / eyeReliefRy, 2),
        )
        const zOrbit = -0.075 * rx * (orbitL + orbitR)
        const zNose =
          0.11 * rx * Math.exp(-Math.pow(u / 0.26, 2) - Math.pow((y - (symEyeY + 0.25 * ry)) / (0.40 * ry), 2))
        const zCheek =
          0.06 *
          rx *
          Math.exp(-Math.pow((Math.abs(u) - 0.74) / 0.36, 2) - Math.pow((y - (symEyeY + 0.36 * ry)) / (0.36 * ry), 2))
        const zBrow =
          0.06 * rx * Math.exp(-Math.pow(u / 0.88, 2) - Math.pow((y - (symEyeY - 0.30 * ry)) / (0.24 * ry), 2))
        const zMouth =
          0.05 * rx * Math.exp(-Math.pow(u / 0.38, 2) - Math.pow((y - (symEyeY + 0.62 * ry)) / (0.28 * ry), 2))
        zFaceRelief = faceRelief * (zOrbit + zNose + zCheek + zBrow + zMouth)
      }

      // 4. Layered 3D depth parallax (vertical root->tip + optional lateral outerZ flare):
      //    At t = 0 (root), smoothstep(t) = 0 so every hair tier with matching rootZRatio welds 0.00px to crown!
      const [defRoot, defTip] = ROLE_DEPTH[role]
      const z0Ratio = l.rootZRatio ?? l.zRatio ?? defRoot
      const z1Ratio = l.tipZRatio ?? l.zRatio ?? defTip
      const st = smoothstep(t)
      const outW = l.outerZRatio !== undefined ? st * smoothstep((Math.abs(u) - 1.08) / 0.72) : 0
      const rawExtra = z0Ratio + (z1Ratio - z0Ratio) * st + (l.outerZRatio ?? 0) * outW
      const depthMix = isRearMount
        ? 1
        : isHairShell
          ? 0.50 + 0.50 * mvHair
          : faceRelief > 0
            ? 0.78 + 0.22 * mvFace
            : 0.38 + 0.62 * mvFace
      const extraZ = rx * rawExtra * depthMix

      // On crownDome > 0, model a true radial 3D sphere on 'crown' (sy < 0):
      // - Along the ENTIRE circular upper silhouette (rSphere = sqrt(sx^2 + sy^2) >= 1), z -> 0 uniformly
      //   so the head outline ALWAYS stays a clean round anime circle (NEVER flat-topped/square or pointy!).
      // - Inside the sphere (whorl, hair parting, forehead), z > 0 rolls boldly in BOTH Yaw & Pitch!
      const isCrown = role === 'crown'
      const rSphere = Math.hypot(sx * 0.96, Math.min(0, sy))
      const crownRimLock = isCrown && crownDome > 0 && sy < 0 ? smoothstep((rSphere - 0.84) / 0.22) : 0
      const crownInteriorKeep = 1 - crownRimLock
      const crownYawInterior =
        isHairShell && crownDome > 0 && sy < 0.15
          ? Math.exp(-0.85 * sxC * sxC - Math.pow((sy + 0.66) / 0.44, 2)) * crownInteriorKeep
          : 0
      const zCrownYawBoost = crownYawInterior > 0 ? rz * 0.42 * crownDome * crownYawInterior : 0

      const dxTurn = (rz * mh * mv * (1 - 0.55 * crownRimLock) + zFaceRelief + zCrownYawBoost + extraZ) * sinY

      // 5. True 3D spherical Pitch dome:
      //    Outer circular crown arch stays round (crownRimLock -> 1 holds z_pitch small uniformly around the circle!),
      //    while the interior hair whorl & forehead roll dramatically up/down inside the round dome!
      const zPitchCrownCore = rz * (0.28 + 0.72 * mhHair) * (sy < 0 ? 0.14 + 0.86 * mvTopDome : 0.34 + 0.66 * mvBotDome)
      const zPitchBase = isHairShell
        ? zPitchCrownCore * (1 - 0.85 * crownRimLock)
        : rz * (0.68 + 0.32 * Math.exp(-0.52 * u2)) * (0.34 + 0.66 * Math.exp(-0.34 * dv * dv)) + zFaceRelief * 0.78
      const zPitchCross = -0.10 * (isHairShell ? uCosHair * 0.55 * (1 - 0.75 * crownRimLock) : us) * rx * sinY
      const pitchExtraWeight = isRearMount ? 0.75 : isHairShell ? 0.72 * (1 - 0.85 * crownRimLock) : faceRelief > 0 ? 0.82 : 0.40
      const zPitch = (zPitchBase + extraZ * pitchExtraWeight) * cosY + zPitchCross
      // Extra spherical top-of-head whorl/crown roll when crownDome > 0 (reveals scalp on DOWN, compresses on UP!)
      const crownWhorlBand =
        isHairShell && crownDome > 0 && sy < 0
          ? Math.exp(-Math.pow((sy + 0.64) / 0.42, 2)) * (0.35 + 0.65 * mhHair) * crownInteriorKeep
          : 0
      const dyCrownRoll = crownWhorlBand > 0 ? rz * 0.58 * crownDome * crownWhorlBand * sinP * cosY : 0
      // On upper spherical dome (sy < 0), only the front surface rolls; no downward cosP silhouette drop!
      const y0 = vc * ry
      const cosPitchFactor = isHairShell && sy < 0 ? 1 - smoothstep(-sy / 0.65) : 1
      const dyPitch = y0 * (cosP - 1) * cosPitchFactor + zPitch * sinP + dyCrownRoll

      // Subtle perspective taper on pitch (forehead & crown narrow cleanly on UP, expand gently on DOWN).
      const dxPitch = -(isHairShell ? uCosHair * 0.62 : us) * rx * 0.052 * (1 + 0.25 * crownDome) * sinP * (isHairShell ? sy : vc - 0.10)
      // Subtle weak-perspective vertical depth scaling on Yaw (near eye subtly larger, far eye slightly tighter).
      const dyYawBase = -y0 * 0.005 * ((isHairShell ? uCosHair * 0.60 : us) * (signY * yawMag))
      const dyPerspRelief =
        !isHairShell && !isRearMount && faceRelief > 0
          ? -(y - symEyeY) * 0.028 * faceRelief * yawMag * (farU * Math.exp(-0.42 * farU * farU))
          : 0
      const dyYaw = dyYawBase + dyPerspRelief

      const rawH = Math.max(0, (neck[1] - y) / fh)
      const swingX = g.skullSwingRatio > 0 ? rx * g.skullSwingRatio * sinY * smoothstep(rawH / 0.92) : 0

      return [dxTurn + dxCos + dxCheek + dxCrownFarTuck + dxPitch + swingX, (dyPitch + dyYaw) * (l.pitchScale ?? 1)]
    }

    function evalPoint(x: number, y: number, role: AutoHeadLayerRole, l: LayerCfg, t: number): Point {
      const fade = belowNeckAttenuation(y)
      if (fade <= 0) return [0, 0]
      const [dx, dy] = evalCore(x, y, role, l, t)
      return [dx * fade, dy * fade]
    }

    if (!pinNeck) {
      return evalPoint
    }

    const neckBase = evalPoint(neck[0], neck[1], 'face', faceCfg, 1)
    return (x: number, y: number, role: AutoHeadLayerRole, l: LayerCfg, t: number): Point => {
      const fade = belowNeckAttenuation(y)
      if (fade <= 0) return [0, 0]
      const raw = evalPoint(x, y, role, l, t)
      return [raw[0] - neckBase[0] * fade, raw[1] - neckBase[1] * fade]
    }
  }

  const autoDiv = (extent: number, faceExtent: number) =>
    Math.min(MAX_FIELD_GRID, Math.max(2, Math.ceil((10 * extent) / faceExtent)))

  const orderedNames = [g.faceLayer, ...Object.keys(layers).filter((n) => n !== g.faceLayer)]
  const morphs: LayerMorphGrid[] = []
  let minJacobian = Infinity
  let maxSymmetryErrorPx = 0

  const poseFields = POSES.map((key, idx) =>
    key === 'center' ? null : makeField((idx % 3) - 1, Math.floor(idx / 3) - 1),
  )

  const neckCorrections: Array<Point | null> = Array(9).fill(null)

  for (const name of orderedNames) {
    const l = layers[name]!
    const bounds = slices.get(name)!
    const [x, y, w, h] = bounds
    // Only truly tiny 2D dot/highlight layers (BOTH width and height <= 24px) translate rigidly at center;
    // wide thin strips like dual-eye brows (180x18) or eye_highlight (162x11) must deform smoothly across width.
    const autoFollow: Point | undefined =
      l.followPoint ??
      (!l.eyePairCenters && name !== g.faceLayer && w <= 24 && h <= 24 ? [x + w / 2, y + h / 2] : undefined)
    const grid: Point =
      l.grid ?? (name === g.faceLayer ? faceGrid : autoFollow ? [1, 1] : [autoDiv(w, fw), autoDiv(h, fh)])
    const corrections = cfg.adjustments?.[name]

    const deltas = POSES.map((key, idx) => {
      const field = poseFields[idx]
      if (key === 'center' || !field) return null
      const ax = (idx % 3) - 1
      const ay = Math.floor(idx / 3) - 1

      // Paired painted two-eye expression slice: sample the exact smooth face surface directly along
      // each grid column's px at the interpolated eye-center height sampleY(px). Zero linear extrapolation
      // overshoot, exact 0px alignment with face_base, and ∂y'/∂y === 1 vertically so deep blink never folds.
      const eyePair = l.eyePairCenters

      const d: number[] = []
      for (let j = 0; j <= grid[1]; j++) {
        const t = j / grid[1]
        const py = y + h * t
        for (let i = 0; i <= grid[0]; i++) {
          const px = x + (w * i) / grid[0]
          let delta: Point
          if (eyePair) {
            const [ea, eb] = eyePair
            const blend = smoothstep(((px - ea[0]) / (eb[0] - ea[0]) - 0.28) / 0.44)
            const sampleY = (1 - blend) * ea[1] + blend * eb[1]
            const hasLayerDepth = l.zRatio !== undefined || l.rootZRatio !== undefined || l.tipZRatio !== undefined
            if (hasLayerDepth) {
              // Keep ∂y'/∂y === 1 (blink-safe!) while letting upper lash (t=0) overhang recessed iris (t=1) in Yaw!
              const dx = field(px, sampleY, 'face', l, t)[0]
              const dy = field(px, sampleY, 'face', l, 0.5)[1]
              delta = [dx, dy]
            } else {
              delta = field(px, sampleY, 'face', faceCfg, 0.5)
            }
          } else if (autoFollow) {
            delta = field(autoFollow[0], autoFollow[1], l.role, l, 0.5)
          } else {
            delta = field(px, py, l.role, l, t)
          }
          d.push(delta[0], delta[1])
        }
      }

      if (pinNeck && name === g.faceLayer) {
        const pin = pinAnchorCell(grid, bounds, d, neck)
        neckCorrections[idx] = pin
      }

      const pin = neckCorrections[idx]
      if (pin) {
        for (let j = 0; j <= grid[1]; j++) {
          const py = y + (h * j) / grid[1]
          const fade = belowNeckAttenuation(py)
          for (let i = 0; i <= grid[0]; i++) {
            const k = (j * (grid[0] + 1) + i) * 2
            d[k] = d[k]! - pin[0] * fade
            d[k + 1] = d[k + 1]! - pin[1] * fade
          }
        }
      }

      if (corrections) {
        const horiz = ax < 0 ? corrections.left : ax > 0 ? corrections.right : undefined
        const vert = ay < 0 ? corrections.up : ay > 0 ? corrections.down : undefined
        const corner = ax && ay ? corrections[key] : undefined
        for (let j = 0; j <= grid[1]; j++) {
          const py = y + (h * j) / grid[1]
          const fade = belowNeckAttenuation(py)
          for (let i = 0; i <= grid[0]; i++) {
            const k = (j * (grid[0] + 1) + i) * 2
            d[k] = d[k]! + fade * ((horiz?.[0] ?? 0) + (vert?.[0] ?? 0) + (corner?.[0] ?? 0))
            d[k + 1] = d[k + 1]! + fade * ((horiz?.[1] ?? 0) + (vert?.[1] ?? 0) + (corner?.[1] ?? 0))
          }
        }
      }

      for (let k = 0; k < d.length; k++) d[k] = round4(d[k]!)
      minJacobian = Math.min(minJacobian, minLatticeJacobian(grid, bounds, d))
      return d
    })

    morphs.push({
      layerId: name,
      grid,
      axes: [
        { parameter: yaw.id, samples: [-1, 0, 1] },
        { parameter: pitch.id, samples: [-1, 0, 1] },
      ],
      deltas,
    })
  }

  if (!(minJacobian >= 0.25)) {
    throw new Error('头部晶格雅可比低于 0.25: ' + minJacobian.toFixed(4))
  }

  // Diagnostics: symmetry, eye widths, 3D midline profile, cheek foreshortening, hair parallax & pitch metrics.
  const faceMorph = morphs[0]!
  const read = (m: LayerMorphGrid, slot: number, px: number, py: number) =>
    sampleLattice(m.grid, slices.get(m.layerId)!, m.deltas[slot]!, px, py)

  for (let j = 0; j <= faceMorph.grid[1]; j++) {
    const py = faceRect[1] + (faceRect[3] * j) / faceMorph.grid[1]
    for (let i = 0; i <= faceMorph.grid[0]; i++) {
      const px = faceRect[0] + (faceRect[2] * i) / faceMorph.grid[0]
      const mirrorX = 2 * cx - px
      if (mirrorX < faceRect[0] || mirrorX > faceRect[0] + faceRect[2]) continue
      for (const row of [0, 3, 6]) {
        const left = read(faceMorph, row, px, py)
        const right = read(faceMorph, row + 2, mirrorX, py)
        maxSymmetryErrorPx = Math.max(maxSymmetryErrorPx, Math.hypot(left[0] + right[0], left[1] - right[1]))
      }
    }
  }

  const faceAt = (u: number, v: number, slot = 5) => read(faceMorph, slot, cx + u * rx, cy + v * ry)
  const eyeY = eyeCenters ? (eyeCenters[0][1] + eyeCenters[1][1]) / 2 : cy + 0.08 * ry
  const eyeLeftX = eyeCenters ? eyeCenters[0][0] : cx - 0.44 * rx
  const eyeRightX = eyeCenters ? eyeCenters[1][0] : cx + 0.44 * rx
  const eyeHalfW = 0.20 * rx
  const eyeWidthPct = (ex: number) => {
    const dL = read(faceMorph, 5, ex - eyeHalfW, eyeY)[0]
    const dR = read(faceMorph, 5, ex + eyeHalfW, eyeY)[0]
    return round4(((dR - dL) / (2 * eyeHalfW)) * 100)
  }

  const roleField = poseFields[5]!
  const neckPinR = neckCorrections[5] ?? [0, 0]
  function maxRoleParallax(role: AutoHeadLayerRole) {
    const vals = morphs
      .filter((m) => layers[m.layerId]!.role === role)
      .map((m) => {
        const [lx, ly, lw, lh] = slices.get(m.layerId)!
        const t = role === 'ear' || role === 'back_hair' ? 0.5 : 0.75
        const px = lx + lw / 2
        const py = ly + lh * t
        const layerDx = read(m, 5, px, py)[0]
        const baseDx = roleField(px, py, 'face', faceCfg, t)[0] - neckPinR[0] * belowNeckAttenuation(py)
        return round4(layerDx - baseDx)
      })
    return vals.length ? (role === 'ear' || role === 'back_hair' ? Math.min(...vals) : Math.max(...vals)) : null
  }

  const chinProbeY = Math.min(chinY, faceRect[1] + faceRect[3])
  const yawMetrics = {
    foreheadDxPx: round4(faceAt(0, -0.78)[0]),
    noseDxPx: round4(faceAt(0, 0.28)[0]),
    mouthDxPx: round4(faceAt(0, 0.64)[0]),
    chinDxPx: round4(read(faceMorph, 5, cx, chinProbeY)[0]),
    nearCheekDxPx: round4(faceAt(-0.84, 0.52)[0]),
    farCheekDxPx: round4(faceAt(0.84, 0.52)[0]),
    farTempleDxPx: round4(faceAt(0.90, 0.04)[0]),
    farEyeWidthPct: eyeWidthPct(eyeRightX),
    nearEyeWidthPct: eyeWidthPct(eyeLeftX),
    frontBangParallaxPx: maxRoleParallax('front_bang'),
    sideburnParallaxPx: maxRoleParallax('sideburn'),
    crownParallaxPx: maxRoleParallax('crown'),
    earParallaxPx: maxRoleParallax('ear'),
  }
  const pitchMetrics = {
    upEyeDyPx: round4(read(faceMorph, 1, eyeRightX, eyeY)[1]),
    upForeheadDyPx: round4(faceAt(0, -0.78, 1)[1]),
    upChinDyPx: round4(read(faceMorph, 1, cx, chinProbeY)[1]),
    upEyeToChinStretchPx: round4(read(faceMorph, 1, cx, chinProbeY)[1] - read(faceMorph, 1, eyeRightX, eyeY)[1]),
    downForeheadDyPx: round4(faceAt(0, -0.78, 7)[1]),
    downEyeDyPx: round4(read(faceMorph, 7, eyeRightX, eyeY)[1]),
    downChinDyPx: round4(read(faceMorph, 7, cx, chinProbeY)[1]),
  }

  const calibration: HeadCalibration = {
    faceLayer: g.faceLayer,
    center: [round4(cx), round4(cy)],
    neckAnchor: [round4(neck[0]), round4(neck[1])],
    pinNeck,
    yaw: { id: yaw.id, deg: yaw.deg },
    pitch: { id: pitch.id, upDeg: pitch.upDeg, downDeg: pitch.downDeg },
    headDepthRatio: g.headDepthRatio,
    skullSwingRatio: g.skullSwingRatio,
  }

  return {
    morphs,
    faceLayer: g.faceLayer,
    neckAnchor: neck,
    pinNeck,
    yaw: yaw.id,
    pitch: pitch.id,
    calibration,
    diagnostics: {
      minJacobian: round4(minJacobian),
      maxSymmetryErrorPx: round4(maxSymmetryErrorPx),
      yawMetrics,
      pitchMetrics,
    },
  }
}
