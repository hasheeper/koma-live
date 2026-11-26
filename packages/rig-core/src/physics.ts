import type { MeshFieldFn } from './mesh-field.js'
import type { HeadCalibration } from './head-morph.js'

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const smoothstep = (u: number) => {
  const t = clamp(u, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Smooth hyperbolic-tangent saturation into `(-limit, limit)`.
 * Unlike hard `clamp()`, `softClamp()` has zero flat-wall deadzone and never
 * causes delayed spring-release snaps.
 */
export function softClamp(value: number, limit: number): number {
  if (!(limit > 0) || !Number.isFinite(limit)) return 0
  if (!Number.isFinite(value)) return 0
  return limit * Math.tanh(value / limit)
}

export interface LowPassFilter {
  value: number
  step(target: number, dtSec: number): number
  reset(initial?: number): void
}

/** Frame-rate-independent exponential low-pass smoother (`rateHz` in `1/s`, e.g. `18` ≈ 55ms lag). */
export function createLowPass(rateHz: number, initial = 0): LowPassFilter {
  if (!(rateHz > 0) || !Number.isFinite(rateHz)) {
    throw new Error('createLowPass rateHz 必须为正有限数')
  }
  return {
    value: initial,
    step(target: number, dtSec: number): number {
      if (!(dtSec > 0) || !Number.isFinite(dtSec)) return this.value
      const alpha = 1 - Math.exp(-rateHz * dtSec)
      this.value += (target - this.value) * alpha
      return this.value
    },
    reset(next = initial) {
      this.value = next
    },
  }
}

export interface DampedSpringOptions {
  /** Spring stiffness `k` (1/s²). */
  stiffness: number
  /** Linear damping `c` (1/s); damping ratio `zeta = c / (2 * sqrt(k))`. */
  damping: number
  /** Hard internal state safety bound (defaults to `softLimit * 1.6` when `softLimit` is set, else `Infinity`). */
  max?: number
  /** Optional smooth `softClamp` output saturation limit (eliminates hard-wall freezing). */
  softLimit?: number
  /** Maximum sub-step size in seconds (default `0.01` = 10ms). */
  maxStepSec?: number
}

export interface DampedSpring {
  readonly stiffness: number
  readonly damping: number
  readonly max: number
  readonly softLimit?: number
  pos: number
  vel: number
  acc: number
  readonly value: number
  step(target: number, dtSec: number): number
  reset(initial?: number): void
}

/**
 * Deterministic sub-stepped 2nd-order damped harmonic spring.
 * When `softLimit` is set, `.step()` and `.value` apply smooth `softClamp`
 * while keeping internal state safely bounded without hard-wall sticking.
 */
export function createDampedSpring(options: DampedSpringOptions): DampedSpring {
  const { stiffness, damping, softLimit, maxStepSec = 0.01 } = options
  if (!(stiffness > 0) || !Number.isFinite(stiffness)) {
    throw new Error('createDampedSpring stiffness 必须为正有限数')
  }
  if (!(damping >= 0) || !Number.isFinite(damping)) {
    throw new Error('createDampedSpring damping 必须为非负有限数')
  }
  const hardMax =
    options.max !== undefined
      ? options.max
      : softLimit !== undefined
        ? softLimit * 1.6
        : Number.POSITIVE_INFINITY
  if (!(hardMax > 0)) {
    throw new Error('createDampedSpring max 必须为正数')
  }
  if (softLimit !== undefined && !(softLimit > 0)) {
    throw new Error('createDampedSpring softLimit 必须为正数')
  }

  return {
    stiffness,
    damping,
    max: hardMax,
    softLimit,
    pos: 0,
    vel: 0,
    acc: 0,
    get value(): number {
      return softLimit !== undefined ? softClamp(this.pos, softLimit) : this.pos
    },
    step(target: number, dtSec: number): number {
      if (!(dtSec > 0) || !Number.isFinite(dtSec)) return this.value
      const clampedDt = Math.min(dtSec, 0.1)
      const steps = Math.max(1, Math.ceil(clampedDt / maxStepSec))
      const h = clampedDt / steps
      for (let i = 0; i < steps; i++) {
        const a = stiffness * (target - this.pos) - damping * this.vel
        this.vel += a * h
        this.pos += this.vel * h
        this.acc = a
      }
      if (this.pos > hardMax) {
        this.pos = hardMax
        if (this.vel > 0) this.vel *= 0.25
      } else if (this.pos < -hardMax) {
        this.pos = -hardMax
        if (this.vel < 0) this.vel *= 0.25
      }
      return this.value
    },
    reset(initial = 0) {
      this.pos = clamp(initial, -hardMax, hardMax)
      this.vel = 0
      this.acc = 0
    },
  }
}

export interface HairStrandOptions {
  /** Spring stiffness `k` (e.g. `42..52` bangs/sideburns, `18..26` long back hair). */
  stiffness: number
  /** Spring damping `c` (golden Live2D zeta ~ `0.32..0.36`). */
  damping: number
  /** Smooth maximum horizontal tip displacement in pixels (`softClamp`). */
  maxPx: number
  /** Horizontal lag gain in px per normalized yaw/sec (default `4.2`). */
  inertiaGain?: number
  /** Horizontal lag gain in px per deg/sec of head tilt angular velocity (default `0.16`). */
  angularGain?: number
  /** Local horizontal gravity plumb gain in px per degree of CW head world rotation (default `0.45`). */
  gravityGain?: number
  /** Horizontal breeze displacement gain in px per breeze unit (default `2.5`). */
  breezeGain?: number
  /** Optional bone length in px for computing synchronized `boneRotationDeg` (default `260`). */
  boneLengthPx?: number
  /**
   * Whether the driven bone hangs downward (`+Y`, default `true`).
   * In top-left Y-down clockwise-degree coordinates, a downward bone needs NEGATIVE
   * rotation to move its tip `+X` (right), whereas an upward bone (e.g. top ahoge)
   * needs POSITIVE rotation to move its tip `+X` (right).
   */
  downwardBone?: boolean
  /** Smooth maximum bone rotation in degrees (default `6`). */
  maxBoneDeg?: number
}

export interface HairStrandInput {
  /** Horizontal head yaw velocity (positive = turning right -> lags left `-X`). */
  headYawVel?: number
  /** Head CW angular velocity in deg/sec (positive = top moving right -> lags left `-X`). */
  headAngVel?: number
  /** Cumulative CW head world rotation in degrees (positive = CW tilt -> gravity plumb `+X`). */
  headWorldRot?: number
  /** Ambient horizontal breeze (positive = blowing right `+X`). */
  breezeX?: number
  /** Optional extra horizontal target displacement in pixels (`+X` right). */
  extraTargetX?: number
  /** Frame step duration in seconds. */
  dtSec: number
}

export interface HairStrandState {
  /** Unified canvas horizontal displacement in pixels (`+` right, `-` left). */
  dx: number
  /** Horizontal spring velocity in px/sec. */
  vel: number
  /** Bone rotation in clockwise degrees guaranteed to move the tip in the exact same direction as `dx`. */
  boneRotationDeg: number
}

export interface HairStrandController {
  readonly spring: DampedSpring
  step(input: HairStrandInput): HairStrandState
  reset(): void
}

/**
 * Unified canvas-coordinate (`+X` right, `+Y` down) Newtonian hair strand controller.
 * Guarantees physically true negative inertia (tip always trails opposite to head motion)
 * and keeps bone rotation & mesh-field `dx` 100% sign-aligned.
 */
export function createHairStrand(options: HairStrandOptions): HairStrandController {
  const {
    stiffness,
    damping,
    maxPx,
    inertiaGain = 4.2,
    angularGain = 0.16,
    gravityGain = 0.45,
    breezeGain = 2.5,
    boneLengthPx = 260,
    downwardBone = true,
    maxBoneDeg = 6,
  } = options
  if (!(boneLengthPx > 0) || !Number.isFinite(boneLengthPx)) {
    throw new Error('createHairStrand boneLengthPx 必须为正有限数')
  }
  const spring = createDampedSpring({
    stiffness,
    damping,
    softLimit: maxPx,
    max: maxPx * 1.75,
  })
  const boneSign = downwardBone ? -1 : 1
  return {
    spring,
    step(input: HairStrandInput): HairStrandState {
      const {
        headYawVel = 0,
        headAngVel = 0,
        headWorldRot = 0,
        breezeX = 0,
        extraTargetX = 0,
        dtSec,
      } = input
      const targetX =
        headWorldRot * gravityGain -
        headYawVel * inertiaGain -
        headAngVel * angularGain +
        breezeX * breezeGain +
        extraTargetX
      const dx = spring.step(targetX, dtSec)
      const rawDeg = boneSign * (dx / boneLengthPx) * DEG
      return {
        dx,
        vel: spring.vel,
        boneRotationDeg: softClamp(rawDeg, maxBoneDeg),
      }
    },
    reset() {
      spring.reset(0)
    },
  }
}

export interface WeldedMeshFieldOptions {
  /** Root attachment point X in canvas rest coordinates. */
  rootX: number
  /** Root attachment point Y in canvas rest coordinates. */
  rootY: number
  /** Distance from root to distal tip in canvas pixels. */
  spanLenPx: number
  /** Normalized `[0, 1)` distance over which the child stays 100% locked to the parent field (default `0.22`). */
  pinRatio?: number
  /** Smooth falloff power past `pinRatio` (default `1.6`). */
  tipPower?: number
  /** Optional extra child displacement evaluated at `(u, v, x, y, tipW, s)` and added atop `[px, py]`. */
  extraField?: (u: number, v: number, x: number, y: number, tipW: number, s: number) => readonly [number, number]
}

/**
 * Create a root-welded child `MeshFieldFn` that inherits exact parent displacement `[px, py]`
 * at its root (`0.0000 px` detachment) and smoothly layers child secondary motion toward the tip.
 */
export function createWeldedMeshField(
  parentField: MeshFieldFn,
  options: WeldedMeshFieldOptions,
): MeshFieldFn {
  const { rootX, rootY, spanLenPx, pinRatio = 0.22, tipPower = 1.6, extraField } = options
  if (!(spanLenPx > 0) || !Number.isFinite(spanLenPx)) {
    throw new Error('createWeldedMeshField spanLenPx 必须为正有限数')
  }
  const pin = clamp(pinRatio, 0, 0.95)
  const denom = 1 - pin
  return (u, v, x, y) => {
    const [px, py] = parentField(u, v, x, y)
    const s = clamp(Math.hypot(x - rootX, y - rootY) / spanLenPx, 0, 1)
    if (s <= pin || !extraField) return [px, py]
    const tipW = Math.pow(smoothstep((s - pin) / denom), tipPower)
    if (tipW <= 1e-6) return [px, py]
    const [ex, ey] = extraField(u, v, x, y, tipW, s)
    return [px + ex, py + ey]
  }
}

/**
 * Orthographic 3D projection for rear/side skull accessories (bows, back hair, halos)
 * driven directly from the single-source `HeadCalibration` metadata exported by `rig auto-head`.
 */
export function projectHeadAccessory(
  calibration: Pick<HeadCalibration, 'center' | 'yaw' | 'pitch'>,
  headYaw: number,
  headPitch: number,
  x: number,
  y: number,
  z: number,
): [number, number] {
  const [hcx, hcy] = calibration.center
  const yawRad = headYaw * calibration.yaw.deg * RAD
  const pitchDeg = headPitch >= 0 ? calibration.pitch.downDeg : calibration.pitch.upDeg
  const pitchRad = headPitch * pitchDeg * RAD
  const cosY = Math.cos(yawRad)
  const sinY = Math.sin(yawRad)
  const cosP = Math.cos(pitchRad)
  const sinP = Math.sin(pitchRad)
  const rx = x - hcx
  const ry = y - hcy
  const x1 = rx * cosY + z * sinY
  const z1 = -rx * sinY * 0.30 + z * cosY
  const y2 = ry * cosP + z1 * sinP
  return [x1 - rx, y2 - ry]
}

export interface PhysicsToolkit {
  softClamp: typeof softClamp
  createLowPass: typeof createLowPass
  createDampedSpring: typeof createDampedSpring
  createHairStrand: typeof createHairStrand
  createWeldedMeshField: typeof createWeldedMeshField
  projectHeadAccessory: typeof projectHeadAccessory
}

export function createPhysicsToolkit(): PhysicsToolkit {
  return {
    softClamp,
    createLowPass,
    createDampedSpring,
    createHairStrand,
    createWeldedMeshField,
    projectHeadAccessory,
  }
}
