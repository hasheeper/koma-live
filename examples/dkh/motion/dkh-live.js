// Single-file self-contained ES Module (no external imports)
// DKH — Route A Living Portrait Idle (koma-rig.performance.v1)
//
// Physics & craft architecture:
// 1. Anti-jellyfish decoupling: asymmetric breathing stays strictly inside core torso/head;
//    hair, jacket, skirt, belt & ribbons are NEVER symmetrically pulsed by breath.
// 2. Real 2nd-order damped harmonic springs driven by:
//    (a) live anchor inertia (head turn / hip weight shift / chest acceleration -> Newton lag & overshoot),
//    (b) unidirectional gusting ambient breeze with spatial wavefront delay across canvas X.
// 3. Right-side 4-layer depth parallax: upper arm -> draped collar -> foreground puffer sleeve & hand ->
//    heavy free-hanging zipper coat flap (2-bone chain) + independent front/back sleeve bow ribbons.
// 4. Pleated skirt 2-bone chain: leather waistband locked 0° onto hip, skirt_hem swings with cloth inertia.
// 5. Analytical 2-Bone IK locks both chunky boots (<0.01px floor slide) and left gloved hand onto mask (<0.3px).

export const meta = {
  format: 'koma-rig.performance.v1',
  title: 'DKH · 物理弹簧待机',
  states: ['idle'],
  triggers: [],
  layers: { back: '2d', front: false },
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function wrapDeg(deg) {
  let a = ((deg + 180) % 360 + 360) % 360 - 180
  return a === -180 ? 180 : a
}

function smoothstep(t) {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

function smootherstep(t) {
  const u = clamp(t, 0, 1)
  return u * u * u * (u * (u * 6 - 15) + 10)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function canvasDeltaToParentLocal(dx, dy, parentWorldRestDeg) {
  const rad = -parentWorldRestDeg * DEG2RAD
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: dx * c - dy * s, y: dx * s + dy * c }
}

function buildWorldRestAngles(bones) {
  const byId = new Map(bones.map((b) => [b.boneId, b]))
  const worldDeg = new Map()
  function resolve(id) {
    if (worldDeg.has(id)) return worldDeg.get(id)
    const b = byId.get(id)
    if (!b) return 0
    const deg = (b.parentBoneId ? resolve(b.parentBoneId) : 0) + b.restRotation
    worldDeg.set(id, deg)
    return deg
  }
  for (const b of bones) resolve(b.boneId)
  return worldDeg
}

// 2D rigid forward kinematics helpers (scale = 1)
function matTranslate(tx, ty) {
  return [1, 0, 0, 1, tx, ty]
}
function matRotate(deg) {
  const r = deg * DEG2RAD
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}
function matMul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
function matAngleDeg(m) {
  return Math.atan2(m[1], m[0]) * RAD2DEG
}

function solveTwoBoneIK(rootX, rootY, targetX, targetY, L1, L2, bendSign) {
  const dx = targetX - rootX
  const dy = targetY - rootY
  const rawDist = Math.hypot(dx, dy)
  const minDist = Math.abs(L1 - L2) + 0.5
  const maxDist = L1 + L2 - 0.12
  const dist = clamp(rawDist, minDist, maxDist)
  const baseAngle = Math.atan2(dy, dx)
  const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1)
  const angle1 = baseAngle - bendSign * Math.acos(cosA)
  const kneeX = rootX + Math.cos(angle1) * L1
  const kneeY = rootY + Math.sin(angle1) * L1
  const scale = rawDist > 1e-6 ? dist / rawDist : 1
  const clampedTX = rootX + dx * scale
  const clampedTY = rootY + dy * scale
  const angle2 = Math.atan2(clampedTY - kneeY, clampedTX - kneeX)
  return { upperWorldDeg: angle1 * RAD2DEG, lowerWorldDeg: angle2 * RAD2DEG }
}

/**
 * Natural asymmetric breathing wave in [0, 1]:
 * quiet slow inhale (0..0.41) -> soft apex pause (0.41..0.49) -> relaxed sigh exhale (0.49..1.0).
 * Period = 4.35s, strictly decoupled from exterior breeze & cloth frequencies.
 */
function asymmetricBreath(tSec, periodSec = 4.35) {
  const u = ((tSec / periodSec) % 1 + 1) % 1
  if (u < 0.41) return smootherstep(u / 0.41)
  if (u < 0.49) {
    const h = (u - 0.41) / 0.08
    return 1 - 0.02 * smoothstep(h)
  }
  const e = (u - 0.49) / 0.51
  return 0.98 * (1 - smootherstep(Math.pow(e, 0.88)))
}

/**
 * Unidirectional gusting ambient breeze with spatial wavefront propagation across canvas X.
 * Positive value = breeze blowing left-to-right (+X); negative = gentle back-eddy (-X).
 * Non-periodic multi-scale envelope creates calm lulls and soft sweeping gusts instead of robotic loops.
 */
function sampleBreeze(tSec, worldX) {
  // Wavefront travels across character at ~760 px/s (left twintail -> bangs/skirt -> right jacket/bow -> right twintail)
  const localT = tSec - (worldX - 460) / 760
  // Slow organic gust envelope [0.18 .. 1.0] (periods ~9.7s & ~15.3s, far from 4.35s breath)
  const env = 0.58 + 0.30 * Math.sin(localT * 0.648 + 0.4) + 0.14 * Math.sin(localT * 0.411 + 2.2)
  // Directional wave with gentle eddies (periods ~5.4s, ~3.0s, ~1.7s)
  const gust =
    0.52 * Math.sin(localT * 1.16 + 0.2) +
    0.34 * Math.sin(localT * 2.09 - 0.9) +
    0.16 * Math.sin(localT * 3.67 + 1.5)
  // Subtle baseline prevailing rightward draft (+0.26) so hanging cloth & hair flow coherently
  return (0.26 + gust) * env
}

/**
 * Deterministic 2nd-order damped harmonic oscillator (mass-spring-damper).
 * Sub-stepped internally for frame-rate independent stability (60Hz / 120Hz / 10ms inspect).
 */
function createSpring(stiffness, damping, maxAngleDeg = 18) {
  return {
    k: stiffness,
    c: damping,
    max: maxAngleDeg,
    pos: 0,
    vel: 0,
    acc: 0,
    reset() {
      this.pos = 0
      this.vel = 0
      this.acc = 0
    },
    step(targetAngleDeg, dtSec) {
      if (dtSec <= 0) return this.pos
      const subSteps = Math.max(1, Math.ceil(dtSec / 0.01))
      const h = dtSec / subSteps
      for (let i = 0; i < subSteps; i++) {
        const a = this.k * (targetAngleDeg - this.pos) - this.c * this.vel
        this.vel += a * h
        this.pos += this.vel * h
        this.acc = a
      }
      if (this.pos > this.max) {
        this.pos = this.max
        if (this.vel > 0) this.vel *= 0.25
      } else if (this.pos < -this.max) {
        this.pos = -this.max
        if (this.vel < 0) this.vel *= 0.25
      }
      return this.pos
    },
  }
}

export default function createPerformance(ctx) {
  const { puppet, size, back } = ctx
  const specBones = puppet.spec.bones
  const byId = new Map(specBones.map((b) => [b.boneId, b]))
  const worldRest = buildWorldRestAngles(specBones)

  function parentWorldRestDeg(boneId) {
    const b = byId.get(boneId)
    return b && b.parentBoneId ? (worldRest.get(b.parentBoneId) ?? 0) : 0
  }

  const localRest = new Map()
  for (const b of specBones) {
    if (!b.parentBoneId) {
      localRest.set(b.boneId, { lx: b.restStart[0], ly: b.restStart[1], rot: b.restRotation })
    } else {
      const p = byId.get(b.parentBoneId)
      const pDeg = worldRest.get(b.parentBoneId) ?? 0
      const loc = canvasDeltaToParentLocal(
        b.restStart[0] - p.restStart[0],
        b.restStart[1] - p.restStart[1],
        pDeg,
      )
      localRest.set(b.boneId, { lx: loc.x, ly: loc.y, rot: b.restRotation })
    }
  }

  function stepFK(parentMat, boneId, delta) {
    const lr = localRest.get(boneId)
    const tx = lr.lx + (delta?.x ?? 0)
    const ty = lr.ly + (delta?.y ?? 0)
    const rot = lr.rot + (delta?.rotation ?? 0)
    return matMul(parentMat, matMul(matTranslate(tx, ty), matRotate(rot)))
  }

  function readChain(upperId, lowerId, endId) {
    const u = byId.get(upperId)
    const l = byId.get(lowerId)
    const e = endId ? byId.get(endId) : null
    const ux = u.restEnd[0] - u.restStart[0]
    const uy = u.restEnd[1] - u.restStart[1]
    const lx = l.restEnd[0] - l.restStart[0]
    const ly = l.restEnd[1] - l.restStart[1]
    const cross = ux * ly - uy * lx
    return {
      L1: u.length,
      L2: l.length,
      bendSign: cross >= 0 ? 1 : -1,
      upperRestWorldDeg: worldRest.get(upperId),
      lowerRestWorldDeg: worldRest.get(lowerId),
      endRestWorldDeg: e ? worldRest.get(endId) : 0,
      targetRest: [l.restEnd[0], l.restEnd[1]],
    }
  }

  const legL = readChain('thigh_l', 'shin_l', 'foot_l')
  const legR = readChain('thigh_r', 'shin_r', 'foot_r')
  const armL = readChain('arm_l_upper', 'arm_l_lower', 'hand_l')

  const maskBone = byId.get('mask')
  const handLBone = byId.get('hand_l')
  const maskRestWorldDeg = worldRest.get('mask')
  const wristFromMaskOrigin = canvasDeltaToParentLocal(
    handLBone.restStart[0] - maskBone.restStart[0],
    handLBone.restStart[1] - maskBone.restStart[1],
    maskRestWorldDeg,
  )

  // ── Material-Differentiated 2nd-Order Spring Bank ──
  // Heavy puffer jacket (slow, weighty, noticeable inertia & drape)
  const spJacketL = createSpring(18, 4.8, 7)
  const spJacketLTip = createSpring(14, 3.8, 10)
  const spJacketRCollar = createSpring(24, 5.8, 5)
  const spJacketRHem = createSpring(15, 4.1, 7)
  const spJacketRTip = createSpring(12, 3.3, 10)

  // Relaxed right hanging arm & loose gloved hand (distinct frequency from heavy zipper coat behind it!)
  const spArmRUpper = createSpring(22, 5.8, 5)
  const spArmRLower = createSpring(19, 4.9, 6)
  const spHandR = createSpring(28, 5.2, 9)

  // High-contrast right sleeve bow (independent front/back light silky ribbons)
  const spBowRFront = createSpring(38, 4.6, 11)
  const spBowRBack = createSpring(30, 3.8, 13)

  // Pleated skirt hem (waistband locked 0 deg; lower hem swings freely with cloth inertia)
  const spSkirtHem = createSpring(24, 4.8, 8)

  // Dangling leather belt pendulum (2-bone chain)
  const spBelt1 = createSpring(20, 3.9, 10)
  const spBelt2 = createSpring(16, 3.2, 13)

  // Long twin-tails (3-bone physics chains with distinct left/right natural resonance)
  const spTL1 = createSpring(22, 4.8, 7)
  const spTL2 = createSpring(18, 4.0, 9)
  const spTL3 = createSpring(15, 3.3, 11)

  const spTR1 = createSpring(20, 4.5, 7)
  const spTR2 = createSpring(16, 3.7, 9)
  const spTR3 = createSpring(13.5, 3.1, 11)

  // Front bangs
  const spBangC = createSpring(38, 6.8, 4)
  const spBangL = createSpring(36, 6.2, 4.5)
  const spBangLS1 = createSpring(28, 5.4, 6)
  const spBangLS2 = createSpring(22, 4.3, 8)
  const spBangRS1 = createSpring(26, 5.1, 6)
  const spBangRS2 = createSpring(20, 4.1, 8)

  // 7 head ribbons (rabbit-ear bows + airy hanging tails)
  const spRibLUp1 = createSpring(48, 6.2, 7)
  const spRibLUp2 = createSpring(54, 6.5, 7)
  const spRibLDown = createSpring(32, 4.1, 10)
  const spRibRUp1 = createSpring(46, 6.0, 7)
  const spRibRUp2 = createSpring(52, 6.4, 7)
  const spRibRDown1 = createSpring(40, 4.8, 9)
  const spRibRDown2 = createSpring(29, 3.8, 11)

  const allSprings = [
    spJacketL, spJacketLTip, spJacketRCollar, spJacketRHem, spJacketRTip,
    spArmRUpper, spArmRLower, spHandR, spBowRFront, spBowRBack,
    spSkirtHem, spBelt1, spBelt2,
    spTL1, spTL2, spTL3, spTR1, spTR2, spTR3,
    spBangC, spBangL, spBangLS1, spBangLS2, spBangRS1, spBangRS2,
    spRibLUp1, spRibLUp2, spRibLDown, spRibRUp1, spRibRUp2, spRibRDown1, spRibRDown2,
  ]

  // Deterministic runtime state (reset cleanly inside reset())
  let state = 'idle'
  let rand = mulberry32(20261121)

  let lookX = 0
  let lookY = 0
  let headLookX = 0
  let headLookY = 0
  let autoGazeX = 0
  let autoGazeY = 0
  let nextSaccadeMs = 2200

  let blinkStartMs = 1700
  let pendingDoubleBlink = false

  let nextTwitchMs = 3400
  let twitchSide = 1
  let twitchPos = 0
  let twitchVel = 0

  // Kinematics derivative tracker (computes real anchor velocities/accelerations for spring inertia!)
  let hasPrevKin = false
  let prevHipX = 0
  let prevHipY = 0
  let prevHipVx = 0
  let prevHipVy = 0
  let prevChestY = 0
  let prevChestVy = 0
  let prevHeadWorldDeg = 0
  let prevHeadAngVel = 0

  function resetState() {
    rand = mulberry32(20261121)
    lookX = 0
    lookY = 0
    headLookX = 0
    headLookY = 0
    autoGazeX = 0
    autoGazeY = 0
    nextSaccadeMs = 2200
    blinkStartMs = 1700
    pendingDoubleBlink = false
    nextTwitchMs = 3400
    twitchSide = 1
    twitchPos = 0
    twitchVel = 0
    hasPrevKin = false
    prevHipX = 0
    prevHipY = 0
    prevHipVx = 0
    prevHipVy = 0
    prevChestY = 0
    prevChestVy = 0
    prevHeadWorldDeg = 0
    prevHeadAngVel = 0
    for (const sp of allSprings) sp.reset()
  }

  function clearBack() {
    back?.ctx2d?.clearRect(0, 0, size.width, size.height)
  }

  function evalBlink(timeMs) {
    const closeMs = 55
    const holdMs = 28
    const openMs = 125
    const totalMs = closeMs + holdMs + openMs

    while (timeMs >= blinkStartMs + totalMs) {
      if (pendingDoubleBlink) {
        blinkStartMs += totalMs + 115
        pendingDoubleBlink = false
      } else {
        const gap = 2800 + rand() * 3400
        blinkStartMs += totalMs + gap
        pendingDoubleBlink = rand() < 0.22
      }
    }

    const elapsed = timeMs - blinkStartMs
    if (elapsed <= 0 || elapsed >= totalMs) return 0
    if (elapsed < closeMs) return smoothstep(elapsed / closeMs)
    if (elapsed < closeMs + holdMs) return 1
    return 1 - smootherstep((elapsed - closeMs - holdMs) / openMs)
  }

  function drawGroundShadow(pose) {
    if (!back?.ctx2d) return
    const g = back.ctx2d
    g.clearRect(0, 0, size.width, size.height)
    const fL = pose.bones?.find((b) => b.boneId === 'foot_l')
    const fR = pose.bones?.find((b) => b.boneId === 'foot_r')
    if (!fL || !fR) return

    const midX = (fL.end[0] + fR.end[0]) * 0.5 + 4
    const baseY = Math.max(fL.end[1], fR.end[1]) - 6

    g.save()
    const broad = g.createRadialGradient(midX, baseY - 12, 16, midX, baseY - 12, 195)
    broad.addColorStop(0, 'rgba(10, 12, 18, 0.34)')
    broad.addColorStop(0.55, 'rgba(10, 12, 18, 0.14)')
    broad.addColorStop(1, 'rgba(10, 12, 18, 0)')
    g.fillStyle = broad
    g.save()
    g.translate(midX, baseY - 12)
    g.scale(1, 0.24)
    g.beginPath()
    g.arc(0, 0, 195, 0, Math.PI * 2)
    g.fill()
    g.restore()

    for (const [sx, sy, rx, ry, alpha] of [
      [fL.end[0] - 4, fL.end[1] + 2, 74, 20, 0.32],
      [fR.end[0] + 6, fR.end[1] + 2, 76, 22, 0.24],
    ]) {
      const grad = g.createRadialGradient(sx, sy, 4, sx, sy, rx)
      grad.addColorStop(0, `rgba(8, 10, 16, ${alpha})`)
      grad.addColorStop(1, 'rgba(8, 10, 16, 0)')
      g.fillStyle = grad
      g.save()
      g.translate(sx, sy)
      g.scale(1, ry / rx)
      g.beginPath()
      g.arc(0, 0, rx, 0, Math.PI * 2)
      g.fill()
      g.restore()
    }
    g.restore()
  }

  return {
    setState(next) {
      state = next || 'idle'
    },
    trigger() {
      // Focused living-idle physics showcase
    },
    reset() {
      resetState()
      puppet.reset()
      clearBack()
    },
    update({ timeMs, dtMs, pointer }) {
      const t = timeMs / 1000
      const dt = Math.min(Math.max(dtMs, 0), 50) / 1000

      // ── 1. Autonomous Micro-Saccades vs Live Pointer Gaze ──
      while (timeMs >= nextSaccadeMs) {
        const roll = rand()
        if (roll < 0.42) {
          autoGazeX = 0
          autoGazeY = 0
        } else {
          autoGazeX = (rand() * 2 - 1) * 0.72
          autoGazeY = (rand() * 2 - 1) * 0.45
        }
        nextSaccadeMs += 3100 + rand() * 3800
      }

      const targetGazeX = pointer.inside ? clamp(pointer.nx, -1, 1) : autoGazeX
      const targetGazeY = pointer.inside ? clamp(pointer.ny, -1, 1) : autoGazeY
      const eyeFollow = dt > 0 ? 1 - Math.exp(-11 * dt) : 1
      const headFollow = dt > 0 ? 1 - Math.exp(-3.4 * dt) : 1
      lookX += (targetGazeX - lookX) * eyeFollow
      lookY += (targetGazeY - lookY) * eyeFollow
      headLookX += (targetGazeX - headLookX) * headFollow
      headLookY += (targetGazeY - headLookY) * headFollow

      // ── 2. Subtle Rabbit-Ear Ribbon Micro-Twitch ──
      while (timeMs >= nextTwitchMs) {
        twitchSide = rand() < 0.5 ? 1 : -1
        twitchVel += 42 + rand() * 14
        nextTwitchMs += 4600 + rand() * 4400
      }
      if (dt > 0) {
        const acc = -190 * twitchPos - 16 * twitchVel
        twitchVel += acc * dt
        twitchPos += twitchVel * dt
      }

      // ── 3. Core Internal Rhythm ONLY (Strictly Decoupled From Hair/Cloth) ──
      const breathHip = asymmetricBreath(t, 4.35)
      const breathTorso = asymmetricBreath(t - 0.16, 4.35)
      const breathChest = asymmetricBreath(t - 0.28, 4.35)
      const breathNeck = asymmetricBreath(t - 0.40, 4.35)
      const breathHead = asymmetricBreath(t - 0.52, 4.35)

      // Slow organic standing weight shift (7.73s & 12.19s — non-repeating)
      const slowSway = Math.sin(t * ((Math.PI * 2) / 7.73))
      const ultraSlow = Math.sin(t * ((Math.PI * 2) / 12.19) + 1.1)

      // Base hip drop keeps leg_l strictly below L1+L2 throughout breath -> 0px boot slide
      const hipDx = slowSway * 3.8 + ultraSlow * 1.4 + headLookX * 2.2
      const hipDy = 4.6 + (1 - breathHip) * 4.2
      const hipRot = slowSway * 0.65
      const hipLocal = canvasDeltaToParentLocal(hipDx, hipDy, parentWorldRestDeg('hip'))

      const torsoRot = -slowSway * 0.75 + (breathTorso - 0.5) * 0.8 + headLookX * 0.8
      const chestRot = slowSway * 0.5 - (breathChest - 0.5) * 1.15 + headLookX * 1.15
      const chestLift = canvasDeltaToParentLocal(0, -(breathChest - 0.5) * 2.4, parentWorldRestDeg('chest'))
      const neckRot = (breathNeck - 0.5) * 0.65 + headLookX * 1.55 + headLookY * 0.6
      const headRot = (breathHead - 0.5) * 1.0 - slowSway * 0.45 + headLookX * 2.7 + headLookY * 1.15

      // Mask sits on head; gentle breath-hand micro tug
      const maskRot = (breathChest - breathHead) * 1.1 + Math.sin(t * 1.38) * 0.28

      // ── 4. Exact Forward Kinematics for IK & Real Anchor Acceleration ──
      const rootMat = stepFK([1, 0, 0, 1, 0, 0], 'root', null)
      const hipDelta = { x: hipLocal.x, y: hipLocal.y, rotation: hipRot }
      const torsoDelta = { rotation: torsoRot }
      const chestDelta = { x: chestLift.x, y: chestLift.y, rotation: chestRot }
      const neckDelta = { rotation: neckRot }
      const headDelta = { rotation: headRot }
      const maskDelta = { rotation: maskRot }

      const hipMat = stepFK(rootMat, 'hip', hipDelta)
      const torsoMat = stepFK(hipMat, 'torso', torsoDelta)
      const chestMat = stepFK(torsoMat, 'chest', chestDelta)
      const neckMat = stepFK(chestMat, 'neck', neckDelta)
      const headMat = stepFK(neckMat, 'head', headDelta)
      const maskMat = stepFK(headMat, 'mask', maskDelta)

      // Measure real anchor velocities & accelerations (used as true inertial inputs to springs!)
      const curHipX = hipMat[4]
      const curHipY = hipMat[5]
      const curChestY = chestMat[5]
      const curHeadWorldDeg = wrapDeg(matAngleDeg(headMat) - worldRest.get('head'))

      let hipVx = 0
      let hipAx = 0
      let hipAy = 0
      let chestVy = 0
      let chestAy = 0
      let headAngVel = 0
      let headAngAcc = 0
      if (hasPrevKin && dt > 1e-4) {
        hipVx = (curHipX - prevHipX) / dt
        const hipVy = (curHipY - prevHipY) / dt
        hipAx = clamp((hipVx - prevHipVx) / dt, -240, 240)
        hipAy = clamp((hipVy - prevHipVy) / dt, -240, 240)
        chestVy = (curChestY - prevChestY) / dt
        chestAy = clamp((chestVy - prevChestVy) / dt, -240, 240)
        headAngVel = wrapDeg(curHeadWorldDeg - prevHeadWorldDeg) / dt
        headAngAcc = clamp((headAngVel - prevHeadAngVel) / dt, -400, 400)
        prevHipVx = hipVx
        prevHipVy = hipVy
        prevChestVy = chestVy
        prevHeadAngVel = headAngVel
      } else {
        hasPrevKin = true
      }
      prevHipX = curHipX
      prevHipY = curHipY
      prevChestY = curChestY
      prevHeadWorldDeg = curHeadWorldDeg

      // ── 4a. Analytical 2-Bone Leg IK (Both Boots Welded <0.01px) ──
      const hipWorldDeltaDeg = wrapDeg(matAngleDeg(hipMat) - worldRest.get('hip'))

      const thighLStart = matApply(hipMat, localRest.get('thigh_l').lx, localRest.get('thigh_l').ly)
      const ikL = solveTwoBoneIK(
        thighLStart[0],
        thighLStart[1],
        legL.targetRest[0],
        legL.targetRest[1],
        legL.L1,
        legL.L2,
        legL.bendSign,
      )
      const thighLRot = wrapDeg(ikL.upperWorldDeg - (legL.upperRestWorldDeg + hipWorldDeltaDeg))
      const shinLRot = wrapDeg(ikL.lowerWorldDeg - (legL.lowerRestWorldDeg + hipWorldDeltaDeg + thighLRot))
      const footLRot = wrapDeg(-(hipWorldDeltaDeg + thighLRot + shinLRot))

      const thighRStart = matApply(hipMat, localRest.get('thigh_r').lx, localRest.get('thigh_r').ly)
      const ikR = solveTwoBoneIK(
        thighRStart[0],
        thighRStart[1],
        legR.targetRest[0],
        legR.targetRest[1],
        legR.L1,
        legR.L2,
        legR.bendSign,
      )
      const thighRRot = wrapDeg(ikR.upperWorldDeg - (legR.upperRestWorldDeg + hipWorldDeltaDeg))
      const shinRRot = wrapDeg(ikR.lowerWorldDeg - (legR.lowerRestWorldDeg + hipWorldDeltaDeg + thighRRot))
      const footRRot = wrapDeg(-(hipWorldDeltaDeg + thighRRot + shinRRot))

      // ── 4b. Analytical 2-Bone Left Arm IK (Gloved Hand Locked to Mask) ──
      const chestWorldDeltaDeg = wrapDeg(matAngleDeg(chestMat) - worldRest.get('chest'))
      const maskWorldDeltaDeg = wrapDeg(matAngleDeg(maskMat) - maskRestWorldDeg)
      const shoulderLStart = matApply(chestMat, localRest.get('arm_l_upper').lx, localRest.get('arm_l_upper').ly)
      const wristTarget = matApply(maskMat, wristFromMaskOrigin.x, wristFromMaskOrigin.y)
      const ikArmL = solveTwoBoneIK(
        shoulderLStart[0],
        shoulderLStart[1],
        wristTarget[0],
        wristTarget[1],
        armL.L1,
        armL.L2,
        armL.bendSign,
      )
      const armLUpperRot = wrapDeg(ikArmL.upperWorldDeg - (armL.upperRestWorldDeg + chestWorldDeltaDeg))
      const armLLowerRot = wrapDeg(ikArmL.lowerWorldDeg - (armL.lowerRestWorldDeg + chestWorldDeltaDeg + armLUpperRot))
      const armLLowerWorldDelta = chestWorldDeltaDeg + armLUpperRot + armLLowerRot
      const handLRot = wrapDeg(maskWorldDeltaDeg * 0.95 - armLLowerWorldDelta)

      // ── 5. Single Eye Blink, Gaze & Cool Micro-Expression ──
      const blink = evalBlink(timeMs)
      const headRestDeg = parentWorldRestDeg('eye_iris')

      const irisDx = lookX < 0 ? lookX * 5.0 : lookX * 2.4
      const irisDy = lookY * 2.0 + blink * 5.8
      const irisLocal = canvasDeltaToParentLocal(irisDx, irisDy, headRestDeg)
      const eyeWhiteScaleY = 1 - 0.88 * blink
      const irisScaleAlongY = 1 - 0.82 * blink

      const lashLocal = canvasDeltaToParentLocal(-blink * 1.2, blink * 14.5 - lookY * 0.7, headRestDeg)
      const lashRot = blink * 4.5 - lookX * 0.6

      const lowerLocal = canvasDeltaToParentLocal(0, -blink * 2.6 + lookY * 0.45, headRestDeg)
      const browLocal = canvasDeltaToParentLocal(
        lookX * 0.8,
        blink * 2.2 - (breathHead - 0.5) * 0.9 - lookY * 1.1,
        headRestDeg,
      )
      const browRot = lookX * 1.6 - blink * 2.2 + ultraSlow * 0.9

      // ── 6. 2nd-Order Spring Physics Driven by Unidirectional Breeze + Anchor Inertia ──
      // Sign convention for downward-hanging bones:
      //   +X rightward breeze -> NEGATIVE rotation (-deg)
      //   +X rightward anchor acceleration -> inertial drag leftward -> POSITIVE rotation (+deg)
      const windLeftHair = sampleBreeze(t, 560)
      const windLeftCoat = sampleBreeze(t, 580)
      const windBelt = sampleBreeze(t, 580)
      const windBangs = sampleBreeze(t, 790)
      const windSkirt = sampleBreeze(t, 760)
      const windRightCoat = sampleBreeze(t, 975)
      const windRightBow = sampleBreeze(t, 1000)
      const windRightHair = sampleBreeze(t, 1055)

      // ── 6a. Right-Side 4-Layer Depth Parallax (No Longer Dead!) ──
      // Layer 1: Upper arm responds gently to shoulder breathing & hip sway (relaxed gravity hang)
      const armRUpperTarget = -chestWorldDeltaDeg * 0.45 + (breathChest - 0.5) * 2.6 + slowSway * 1.4 - windRightCoat * 1.1
      const armRUpperRot = spArmRUpper.step(armRUpperTarget, dt)
      // Layer 2: Foreground puffer sleeve & loose gloved hand trail the upper arm with pendulum inertia
      const armRLowerTarget = -spArmRUpper.vel * 0.14 - windRightCoat * 2.4 + hipAx * 0.015 + Math.sin(t * 1.07 + 0.9) * 1.2
      const armRLowerRot = spArmRLower.step(armRLowerTarget, dt)
      const handRTarget = -spArmRLower.vel * 0.24 - windRightCoat * 3.8 + Math.sin(t * 1.43 - 0.6) * 1.8
      const handRRot = spHandR.step(handRTarget, dt)

      // Layer 3: High-contrast black sleeve bow ribbons (front & back flutter independently!)
      const armRLowerVel = spArmRUpper.vel + spArmRLower.vel
      const bowRFrontTarget = -windRightBow * 8.2 - armRLowerVel * 0.26 + Math.sin(t * 2.95 + 0.4) * 1.9
      const bowRFrontRot = spBowRFront.step(bowRFrontTarget, dt)
      const bowRBackTarget = -windRightBow * 9.8 - armRLowerVel * 0.34 + Math.sin(t * 2.41 - 0.9) * 2.2
      const bowRBackRot = spBowRBack.step(bowRBackTarget, dt)

      // Layer 4: Draped off-shoulder collar & heavy background zipper coat flap (outfit_o_r2)
      // Collar rides on arm_r_upper with fabric friction lag + tiny gravity dip -> creates real 3D separation from sleeve!
      const collarTarget = armRUpperRot * 0.72 - chestAy * 0.018 - windRightCoat * 1.6
      const jacketRCollarRot = spJacketRCollar.step(collarTarget, dt)
      const collarDip = canvasDeltaToParentLocal(
        -windRightCoat * 1.8,
        Math.max(-2.5, Math.min(3.5, -chestVy * 0.08 + (1 - breathChest) * 1.6)),
        parentWorldRestDeg('jacket_r_collar'),
      )
      // Heavy free-hanging zipper coat flap (2-bone chain jacket_r_hem -> bone-51): billows visibly behind sleeve!
      const jRHemTarget = -windRightCoat * 5.4 - spJacketRCollar.vel * 0.22 + hipAx * 0.025 - jacketRCollarRot * 0.35
      const jacketRHemRot = spJacketRHem.step(jRHemTarget, dt)
      const jRTipTarget = -windRightCoat * 7.8 - spJacketRHem.vel * 0.32 + hipAx * 0.032
      const jacketRTipRot = spJacketRTip.step(jRTipTarget, dt)

      // Left heavy draped coat flap (2-bone chain jacket_l -> bone-50): coherent rightward breeze + weight inertia
      const jLTarget = -windLeftCoat * 4.4 - chestWorldDeltaDeg * 0.35 + hipAx * 0.022
      const jacketLRot = spJacketL.step(jLTarget, dt)
      const jLTipTarget = -windLeftCoat * 6.8 - spJacketL.vel * 0.30 + hipAx * 0.028
      const jacketLTipRot = spJacketLTip.step(jLTipTarget, dt)

      // ── 6b. Pleated Skirt (Waistband Locked 0 deg; Lower Hem Swings With Cloth Inertia) ──
      // Waistband bone `skirt` stays strictly 0 deg so twin leather belts stay riveted to her waist/crop-top!
      const skirtHemTarget = -windSkirt * 6.4 + hipAx * 0.038 + hipVx * 0.16 - hipWorldDeltaDeg * 0.5
      const skirtHemRot = spSkirtHem.step(skirtHemTarget, dt)

      // Dangling black leather belt (2-bone pendulum chain hanging from waist)
      const belt1Target = -windBelt * 6.8 + hipAx * 0.042 + hipVx * 0.18 - hipWorldDeltaDeg * 0.45
      const belt1Rot = spBelt1.step(belt1Target, dt)
      const belt2Target = -windBelt * 9.2 - spBelt1.vel * 0.30 + hipAx * 0.048
      const belt2Rot = spBelt2.step(belt2Target, dt)

      // ── 6c. Long Twin-Tails (3-Bone Physics Chains — Respond to Breeze Wavefront + Head Turn Inertia!) ──
      const headInertialDrag = -headAngVel * 0.18 - headAngAcc * 0.012 - curHeadWorldDeg * 0.32

      const tl1Rot = spTL1.step(-windLeftHair * 4.2 + headInertialDrag + hipAx * 0.018, dt)
      const tl2Rot = spTL2.step(-windLeftHair * 6.2 - spTL1.vel * 0.24 + headInertialDrag * 0.55, dt)
      const tl3Rot = spTL3.step(-windLeftHair * 8.4 - spTL2.vel * 0.30 + Math.sin(t * 2.55) * 1.1, dt)

      const tr1Rot = spTR1.step(-windRightHair * 4.4 + headInertialDrag + hipAx * 0.018, dt)
      const tr2Rot = spTR2.step(-windRightHair * 6.4 - spTR1.vel * 0.25 + headInertialDrag * 0.55, dt)
      const tr3Rot = spTR3.step(-windRightHair * 8.6 - spTR2.vel * 0.32 + Math.sin(t * 2.27 + 1.4) * 1.1, dt)

      // ── 6d. Front Bangs (Gentle Breeze + Head Lag; Center Stays Calm Over Eye) ──
      const bangCRot = spBangC.step(-windBangs * 1.4 + headInertialDrag * 0.25, dt)
      const bangLRot = spBangL.step(-windBangs * 1.8 + headInertialDrag * 0.30, dt)
      const bangLS1 = spBangLS1.step(-windBangs * 2.8 + headInertialDrag * 0.42, dt)
      const bangLS2 = spBangLS2.step(-windBangs * 4.4 - spBangLS1.vel * 0.24, dt)
      const bangRS1 = spBangRS1.step(-windBangs * 2.7 + headInertialDrag * 0.40, dt)
      const bangRS2 = spBangRS2.step(-windBangs * 4.3 - spBangRS1.vel * 0.24, dt)

      // ── 6e. 7 Hair Ribbons (Upward Rabbit-Ears Tip With Breeze + Twitch; Hanging Tails Flutter Lightly) ──
      const twitchL = twitchSide < 0 ? twitchPos : 0
      const twitchR = twitchSide > 0 ? twitchPos : 0

      // Upward-pointing rabbit-ear bows rotate +deg under rightward (+X) wind
      const ribLUp1 = spRibLUp1.step(windLeftHair * 3.0 - headInertialDrag * 0.35 - twitchL * 1.3, dt)
      const ribLUp2 = spRibLUp2.step(windLeftHair * 3.6 - headInertialDrag * 0.40 + twitchL * 1.6, dt)
      const ribLDown = spRibLDown.step(-windLeftHair * 7.6 + headInertialDrag * 0.65 + Math.sin(t * 3.1) * 1.1, dt)

      const ribRUp1 = spRibRUp1.step(windRightHair * 3.2 - headInertialDrag * 0.35 + twitchR * 1.4, dt)
      const ribRUp2 = spRibRUp2.step(windRightHair * 3.8 - headInertialDrag * 0.40 - twitchR * 1.1, dt)
      const ribRDown1 = spRibRDown1.step(-windRightHair * 6.4 + headInertialDrag * 0.55 + Math.sin(t * 3.4 + 0.7) * 1.0, dt)
      const ribRDown2 = spRibRDown2.step(-windRightHair * 8.4 + headInertialDrag * 0.70 + Math.sin(t * 2.75 - 0.5) * 1.3, dt)

      // Whisper-subtle silky width foreshortening on thin hanging ribbons proportional to their spring velocity
      const silkL = clamp(1 - Math.abs(spRibLDown.vel) * 0.0018, 0.94, 1.03)
      const silkR = clamp(1 - Math.abs(spRibRDown2.vel) * 0.0018, 0.94, 1.03)
      const silkBowFront = clamp(1 - Math.abs(spBowRFront.vel) * 0.0022, 0.93, 1.03)
      const silkBowBack = clamp(1 - Math.abs(spBowRBack.vel) * 0.0022, 0.93, 1.03)

      void state
      void hipAy

      const pose = puppet.setPose({
        timeMs,
        bones: {
          hip: hipDelta,
          torso: torsoDelta,
          chest: chestDelta,
          neck: neckDelta,
          head: headDelta,
          mask: maskDelta,

          // 2-Bone IK grounded legs & boots (0px slip)
          thigh_l: { rotation: thighLRot },
          shin_l: { rotation: shinLRot },
          foot_l: { rotation: footLRot },
          thigh_r: { rotation: thighRRot },
          shin_r: { rotation: shinRRot },
          foot_r: { rotation: footRRot },

          // 2-Bone IK left arm magnetically locked onto face mask
          arm_l_upper: { rotation: armLUpperRot },
          arm_l_lower: { rotation: armLLowerRot },
          hand_l: { rotation: handLRot },

          // Right-side 4-layer depth parallax: arm/sleeve/hand + independent front/back bow + draped collar & zipper coat
          arm_r_upper: { rotation: armRUpperRot },
          arm_r_lower: { rotation: armRLowerRot },
          hand_r: { rotation: handRRot },
          bow_r: { rotation: bowRFrontRot, scaleY: silkBowFront },
          ...(byId.has('bow_r_back') ? { bow_r_back: { rotation: bowRBackRot, scaleY: silkBowBack } } : {}),
          jacket_r_collar: { x: collarDip.x, y: collarDip.y, rotation: jacketRCollarRot },
          jacket_r_hem: { rotation: jacketRHemRot },
          'bone-51': { rotation: jacketRTipRot },

          // Left heavy coat 2-bone chain
          jacket_l: { rotation: jacketLRot },
          'bone-50': { rotation: jacketLTipRot },

          // Pleated skirt: waistband anchored 0 deg, lower skirt hem swings with cloth physics
          skirt: { rotation: 0 },
          ...(byId.has('skirt_hem') ? { skirt_hem: { rotation: skirtHemRot } } : {}),
          'bone-52': { rotation: skirtHemRot * 0.5 },
          'bone-53': { rotation: skirtHemRot * 0.5 },
          belt_1: { rotation: belt1Rot },
          belt_2: { rotation: belt2Rot },

          // Single eye: gaze, clean blink & micro-brow
          ...(byId.has('eye_white') ? { eye_white: { scaleX: eyeWhiteScaleY, scaleY: 1 } } : {}),
          eye_iris: { x: irisLocal.x, y: irisLocal.y, scaleX: irisScaleAlongY, scaleY: 1 },
          eye_lash: { x: lashLocal.x, y: lashLocal.y, rotation: lashRot },
          eye_lower: { x: lowerLocal.x, y: lowerLocal.y },
          eyebrow: { x: browLocal.x, y: browLocal.y, rotation: browRot },

          // 4 front bangs
          bang_c: { rotation: bangCRot },
          bang_l: { rotation: bangLRot },
          bang_l_side1: { rotation: bangLS1 },
          bang_l_side2: { rotation: bangLS2 },
          bang_r_side1: { rotation: bangRS1 },
          bang_r_side2: { rotation: bangRS2 },

          // 3-bone twin-tail spring chains
          twintail_l1: { rotation: tl1Rot },
          twintail_l2: { rotation: tl2Rot },
          twintail_l3: { rotation: tl3Rot },
          twintail_r1: { rotation: tr1Rot },
          twintail_r2: { rotation: tr2Rot },
          twintail_r3: { rotation: tr3Rot },

          // 7 hair ribbons
          ribbon_l_up1: { rotation: ribLUp1 },
          ribbon_l_up2: { rotation: ribLUp2 },
          ribbon_l_down: { rotation: ribLDown, scaleY: silkL },
          ribbon_r_up1: { rotation: ribRUp1 },
          ribbon_r_up2: { rotation: ribRUp2 },
          ribbon_r_down1: { rotation: ribRDown1 },
          ribbon_r_down2: { rotation: ribRDown2, scaleY: silkR },
        },
      })

      drawGroundShadow(pose)
    },
    destroy() {
      clearBack()
    },
  }
}
