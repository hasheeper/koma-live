import { describe, expect, it } from 'vitest'
import {
  createDampedSpring,
  createHairStrand,
  createLowPass,
  createPhysicsToolkit,
  createWeldedMeshField,
  projectHeadAccessory,
  softClamp,
} from '../src/physics.js'

describe('physics primitives', () => {
  it('softClamp saturates smoothly without hard-wall clipping', () => {
    expect(softClamp(0, 10)).toBe(0)
    expect(softClamp(1000, 10)).toBeLessThanOrEqual(10)
    expect(softClamp(1000, 10)).toBeGreaterThan(9.99)
    expect(softClamp(-1000, 10)).toBeGreaterThanOrEqual(-10)
    // Strictly monotonic: never freezes flat at a finite wall!
    expect(softClamp(25, 10)).toBeGreaterThan(softClamp(15, 10))
  })

  it('createLowPass smooths step impulses frame-rate independently', () => {
    const lpA = createLowPass(18, 0)
    const lpB = createLowPass(18, 0)
    for (let i = 0; i < 6; i++) lpA.step(10, 1 / 60)
    for (let i = 0; i < 12; i++) lpB.step(10, 1 / 120)
    expect(lpA.value).toBeCloseTo(lpB.value, 5)
    expect(lpA.value).toBeGreaterThan(5)
    expect(lpA.value).toBeLessThan(10)
    lpA.reset()
    expect(lpA.value).toBe(0)
  })

  it('createDampedSpring sub-steps deterministically and avoids hard-wall snap', () => {
    const s = createDampedSpring({ stiffness: 42, damping: 4.3, softLimit: 12 })
    let prev = 0
    let maxStep = 0
    for (let i = 0; i < 90; i++) {
      const target = i < 30 ? 30 : 0
      const next = s.step(target, 1 / 60)
      expect(Math.abs(next)).toBeLessThanOrEqual(12)
      maxStep = Math.max(maxStep, Math.abs(next - prev))
      prev = next
    }
    expect(maxStep).toBeLessThan(3.0)
    // Settles near 0 after impulse ends
    for (let i = 0; i < 180; i++) s.step(0, 1 / 60)
    expect(Math.abs(s.value)).toBeLessThan(0.1)
  })

  it('createHairStrand guarantees true Newtonian negative inertia and downward bone sign sync', () => {
    const strand = createHairStrand({
      stiffness: 46,
      damping: 4.5,
      maxPx: 18,
      inertiaGain: 4.5,
      gravityGain: 0.5,
      boneLengthPx: 260,
      downwardBone: true,
      maxBoneDeg: 6,
    })

    // Turning head RIGHT (headYawVel > 0): hair tip MUST lag LEFT (dx < 0)
    // and a downward-pointing bone MUST rotate CLOCKWISE (+deg) to also swing tip LEFT (-X)!
    let state = strand.step({ headYawVel: 3.0, dtSec: 1 / 60 })
    for (let i = 0; i < 15; i++) {
      state = strand.step({ headYawVel: 3.0, dtSec: 1 / 60 })
    }
    expect(state.dx).toBeLessThan(-5)
    expect(state.boneRotationDeg).toBeGreaterThan(1)

    // Turning head LEFT (headYawVel < 0): hair tip MUST lag RIGHT (dx > 0)
    // and downward bone MUST rotate COUNTER-CLOCKWISE (-deg)!
    strand.reset()
    for (let i = 0; i < 16; i++) {
      state = strand.step({ headYawVel: -3.0, dtSec: 1 / 60 })
    }
    expect(state.dx).toBeGreaterThan(5)
    expect(state.boneRotationDeg).toBeLessThan(-1)

    // Clockwise head world tilt (headWorldRot > 0): gravity plumb pulls hair +X in head-local frame
    strand.reset()
    for (let i = 0; i < 120; i++) {
      state = strand.step({ headWorldRot: 10, dtSec: 1 / 60 })
    }
    expect(state.dx).toBeGreaterThan(3)
    expect(state.boneRotationDeg).toBeLessThan(0)
  })

  it('createWeldedMeshField locks root to exact parent displacement (0.0000 px tear)', () => {
    const parent = (_u: number, _v: number, x: number, y: number): readonly [number, number] => [
      (y - 700) * 0.05,
      -(x - 500) * 0.01,
    ]
    const child = createWeldedMeshField(parent, {
      rootX: 520,
      rootY: 900,
      spanLenPx: 400,
      pinRatio: 0.22,
      extraField: (_u, _v, _x, _y, tipW) => [20 * tipW, -4 * tipW],
    })

    // At root & inside pin zone, child MUST match parent identically!
    const pRoot = parent(0.5, 0, 520, 900)
    const cRoot = child(0.5, 0, 520, 900)
    expect(cRoot[0]).toBe(pRoot[0])
    expect(cRoot[1]).toBe(pRoot[1])

    const pNear = parent(0.5, 0.1, 520, 960)
    const cNear = child(0.5, 0.1, 520, 960)
    expect(cNear[0]).toBe(pNear[0])
    expect(cNear[1]).toBe(pNear[1])

    // At tip (s = 1), child equals parent + full extraField
    const pTip = parent(0.5, 1, 520, 1300)
    const cTip = child(0.5, 1, 520, 1300)
    expect(cTip[0]).toBeCloseTo(pTip[0] + 20, 5)
    expect(cTip[1]).toBeCloseTo(pTip[1] - 4, 5)
  })

  it('projectHeadAccessory projects rear accessories opposite to front turn via calibration', () => {
    const cal = {
      center: [500, 500] as [number, number],
      yaw: { id: 'headYaw', deg: 20 },
      pitch: { id: 'headPitch', upDeg: 10, downDeg: 15 },
    }
    const [dx0, dy0] = projectHeadAccessory(cal, 0, 0, 500, 500, -70)
    expect(dx0).toBeCloseTo(0, 6)
    expect(dy0).toBeCloseTo(0, 6)

    // Rear accessory (z < 0) moves LEFT (-X) when head yaws RIGHT (+1) -> true 3D counter-parallax!
    const [dxR] = projectHeadAccessory(cal, 1, 0, 500, 500, -70)
    expect(dxR).toBeLessThan(-20)
    // Toolkit exposes all 6 primitives cleanly
    const kit = createPhysicsToolkit()
    expect(typeof kit.createHairStrand).toBe('function')
    expect(typeof kit.createWeldedMeshField).toBe('function')
  })
})
