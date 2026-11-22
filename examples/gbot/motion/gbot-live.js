// Single-file self-contained ES Module (koma-rig.performance.v1)
// Rigid-body mecha performance for GBot:
// - Strictly scaleX = 1, scaleY = 1 on every bone (zero jelly squash/stretch)
// - Analytical 2-bone leg IK locked to ground plane (zero foot sliding/clipping)
// - 5-phase heavy mechanical jump, clean silhouette wave, crisp metal hit-recoil
export const meta = {
  format: 'koma-rig.performance.v1',
  title: 'GBot · 刚体机械动帧',
  author: 'Koma Live',
  states: ['idle', 'happy', 'alert'],
  triggers: ['jump', 'wave', 'tap'],
  layers: { back: '2d', front: '2d' },
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

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function smoothstep(t) {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

function easeInCubic(t) {
  const u = clamp(t, 0, 1)
  return u * u * u
}

function easeOutCubic(t) {
  const u = 1 - clamp(t, 0, 1)
  return 1 - u * u * u
}

function easeOutBack(t, overshoot = 1.35) {
  const u = clamp(t, 0, 1) - 1
  return 1 + (overshoot + 1) * u * u * u + overshoot * u * u
}

function wrapDeg(angle) {
  let a = ((angle + 180) % 360 + 360) % 360 - 180
  if (a === -180) a = 180
  return a
}

function buildLegRig(bonesById, hipBone, thighId, shinId, footId) {
  const thigh = bonesById.get(thighId)
  const shin = bonesById.get(shinId)
  const foot = bonesById.get(footId)
  if (!thigh || !shin || !foot) return null
  const H0 = thigh.restStart
  const K0 = shin.restStart
  const A0 = foot.restStart
  const T0 = foot.restEnd
  const L1 = Math.hypot(K0[0] - H0[0], K0[1] - H0[1])
  const L2 = Math.hypot(A0[0] - K0[0], A0[1] - K0[1])
  return {
    thighId,
    shinId,
    footId,
    hipRelX: H0[0] - hipBone.restStart[0],
    hipRelY: H0[1] - hipBone.restStart[1],
    ankleRest: [A0[0], A0[1]],
    L1,
    L2,
    thighRestDeg: Math.atan2(K0[1] - H0[1], K0[0] - H0[0]) * DEG,
    shinRestDeg: Math.atan2(A0[1] - K0[1], A0[0] - K0[0]) * DEG,
    footRestDeg: Math.atan2(T0[1] - A0[1], T0[0] - A0[0]) * DEG,
  }
}

/**
 * Analytical 2-bone IK solver with knee bending forward (+X, character facing right).
 * Returns exact local delta rotations for thigh, shin, and foot so the ankle locks to targetA.
 */
function solveLegIK(leg, hipRest, hipX, hipY, hipRotDeg, targetA, footWorldTiltDeg = 0) {
  const hr = hipRotDeg * RAD
  const ch = Math.cos(hr)
  const sh = Math.sin(hr)
  const Hx = hipRest[0] + hipX + leg.hipRelX * ch - leg.hipRelY * sh
  const Hy = hipRest[1] + hipY + leg.hipRelX * sh + leg.hipRelY * ch

  const dx = targetA[0] - Hx
  const dy = targetA[1] - Hy
  const rawDist = Math.hypot(dx, dy)
  const minD = Math.abs(leg.L1 - leg.L2) + 4
  const maxD = leg.L1 + leg.L2 - 0.6
  const dist = clamp(rawDist, minD, maxD)

  const baseAng = Math.atan2(dy, dx)
  const cosAlpha = clamp((leg.L1 * leg.L1 + dist * dist - leg.L2 * leg.L2) / (2 * leg.L1 * dist), -1, 1)
  const alpha = Math.acos(cosAlpha)

  // Subtract alpha so the knee bends clockwise-opposite toward +X (forward).
  const thighWorldRad = baseAng - alpha
  const Kx = Hx + leg.L1 * Math.cos(thighWorldRad)
  const Ky = Hy + leg.L1 * Math.sin(thighWorldRad)
  // Aim shin directly toward clamped ankle along baseAng so joint stays exact.
  const Ax = Hx + Math.cos(baseAng) * dist
  const Ay = Hy + Math.sin(baseAng) * dist
  const shinWorldRad = Math.atan2(Ay - Ky, Ax - Kx)

  const thighWorldDeg = thighWorldRad * DEG
  const shinWorldDeg = shinWorldRad * DEG

  const thighDeltaWorld = wrapDeg(thighWorldDeg - leg.thighRestDeg)
  const shinDeltaWorld = wrapDeg(shinWorldDeg - leg.shinRestDeg)

  const legRot = wrapDeg(thighDeltaWorld - hipRotDeg)
  const shinRot = wrapDeg(shinDeltaWorld - thighDeltaWorld)
  const footRot = wrapDeg(footWorldTiltDeg - shinDeltaWorld)
  return { legRot, shinRot, footRot, reached: rawDist <= maxD + 0.5 }
}

export default function createPerformance(ctx) {
  const { puppet, size, back, front } = ctx
  const bonesById = new Map(puppet.spec.bones.map((b) => [b.boneId, b]))
  const hipBone = bonesById.get('hip')
  const hipRest = hipBone ? hipBone.restStart : [size.width * 0.46, size.height * 0.66]
  const legR = hipBone ? buildLegRig(bonesById, hipBone, 'leg_r', 'shin_r', 'foot_r') : null
  const legL = hipBone ? buildLegRig(bonesById, hipBone, 'leg_l', 'shin_l', 'foot_l') : null
  const groundY = legR ? legR.ankleRest[1] + 50 : size.height * 0.92

  let state = 'idle'
  let rand = mulberry32(20261121)

  // Persistent deterministic state
  let lookX = 0
  let lookY = 0
  let blendHappy = 0
  let blendAlert = 0

  // Mechanical idle head-scan micro-behavior (crisp step-and-hold)
  let scanTimer = 1.6
  let scanTarget = 0
  let scanCurrent = 0

  // Active one-shot action state machine (only one major body action at a time, clean transitions)
  let action = null // { kind: 'jump' | 'wave' | 'tap', elapsed: number, duration: number, hitDir: number }

  // Visual mechanical FX pools (deterministic PRNG, zero jelly blur)
  let shockRings = [] // ground landing/takeoff elliptical rings
  let arcs = [] // sharp electric sparks for metal tap
  let jetLevel = 0 // 0..1 thruster burst intensity on feet

  function clearLayers() {
    back?.ctx2d?.clearRect(0, 0, size.width, size.height)
    front?.ctx2d?.clearRect(0, 0, size.width, size.height)
  }

  function spawnRing(x, y, maxRx, maxRy, color, duration) {
    shockRings.push({ x, y, maxRx, maxRy, color, age: 0, duration })
    if (shockRings.length > 8) shockRings.shift()
  }

  function spawnElectricArcs(cx, cy, count) {
    for (let i = 0; i < count; i++) {
      const baseAngle = -Math.PI * 0.85 + rand() * Math.PI * 1.15
      const len = 28 + rand() * 38
      const pts = [[cx, cy]]
      const segs = 3
      for (let s = 1; s <= segs; s++) {
        const f = s / segs
        const jitter = (rand() - 0.5) * 16 * (1 - f * 0.4)
        const perp = baseAngle + Math.PI / 2
        pts.push([
          cx + Math.cos(baseAngle) * len * f + Math.cos(perp) * jitter,
          cy + Math.sin(baseAngle) * len * f + Math.sin(perp) * jitter,
        ])
      }
      arcs.push({ pts, age: 0, duration: 0.14 + rand() * 0.1 })
    }
    if (arcs.length > 16) arcs.splice(0, arcs.length - 16)
  }

  function resetAll() {
    rand = mulberry32(20261121)
    lookX = 0
    lookY = 0
    blendHappy = state === 'happy' ? 1 : 0
    blendAlert = state === 'alert' ? 1 : 0
    scanTimer = 1.6
    scanTarget = 0
    scanCurrent = 0
    action = null
    shockRings = []
    arcs = []
    jetLevel = 0
    puppet.reset()
    clearLayers()
  }

  return {
    setState(next) {
      state = next
    },
    trigger(name) {
      if (name === 'jump') {
        action = { kind: 'jump', elapsed: 0, duration: 1.28, spawnedLaunch: false, spawnedLand: false }
      } else if (name === 'wave') {
        action = { kind: 'wave', elapsed: 0, duration: 1.38 }
      } else if (name === 'tap') {
        const headBone = puppet.pose.bones?.find((b) => b.boneId === 'head')
        const hx = headBone ? (headBone.start[0] + headBone.end[0]) * 0.5 + 78 : size.width * 0.58
        const hy = headBone ? (headBone.start[1] + headBone.end[1]) * 0.5 - 12 : size.height * 0.26
        spawnElectricArcs(hx, hy, 6)
        action = { kind: 'tap', elapsed: 0, duration: 0.58, hitDir: -1 }
      }
    },
    reset() {
      resetAll()
    },
    update({ timeMs, dtMs, pointer }) {
      const t = timeMs / 1000
      const dt = Math.min(dtMs, 50) / 1000

      // Smooth state blends
      const stateStep = 1 - Math.exp(-8 * dt)
      blendHappy += ((state === 'happy' ? 1 : 0) - blendHappy) * stateStep
      blendAlert += ((state === 'alert' ? 1 : 0) - blendAlert) * stateStep

      // Smooth pointer tracking (clamped)
      const targetLookX = pointer.inside ? clamp(pointer.nx, -1, 1) : 0
      const targetLookY = pointer.inside ? clamp(pointer.ny, -1, 1) : 0
      const lookAlpha = 1 - Math.exp(-7 * dt)
      lookX += (targetLookX - lookX) * lookAlpha
      lookY += (targetLookY - lookY) * lookAlpha

      // Deterministic robotic head-scan in idle (crisp step-and-hold)
      if (dt > 0) {
        scanTimer -= dt
        if (scanTimer <= 0) {
          if (Math.abs(scanTarget) > 0.5) {
            scanTarget = 0
            scanTimer = 1.8 + rand() * 1.6
          } else {
            scanTarget = (rand() > 0.5 ? 1 : -1) * (4.5 + rand() * 4.5)
            scanTimer = 0.75 + rand() * 0.55
          }
        }
        const scanAlpha = 1 - Math.exp(-16 * dt)
        scanCurrent += (scanTarget - scanCurrent) * scanAlpha
      }

      // ── 1. Base continuous posture (state-driven, grounded via IK) ──
      // Keep base hipY >= +6px so legs have comfortable knee flex and never pull off the floor.
      const breath = Math.sin(t * 1.65)
      const beatPhase = (t * 2.35) % 1
      // Crisp mechanical knee-bounce beat in happy mode (sharp dip + quick crisp lock)
      const happyDip = Math.pow(Math.sin(beatPhase * Math.PI), 2)
      const happySway = Math.sin(t * 2.35 * Math.PI)

      let hipX =
        Math.sin(t * 0.75) * 2.5 * (1 - blendAlert) +
        blendHappy * happySway * 7 -
        blendAlert * 6
      let hipY =
        7 +
        breath * 2.2 * (1 - blendAlert * 0.5) +
        blendAlert * 24 +
        blendHappy * happyDip * 14
      let hipRot =
        Math.sin(t * 0.75 - 0.3) * 1.1 +
        blendHappy * happySway * 2.6 -
        blendAlert * 2.5

      let bodyRot =
        Math.sin(t * 1.65 - 0.5) * 1.4 +
        lookX * 2.8 +
        blendAlert * 11 +
        blendHappy * -happySway * 3.5
      let headRot =
        scanCurrent * (1 - blendAlert * 0.6) * (1 - Math.min(1, Math.abs(lookX) * 1.5)) +
        lookX * 9 +
        lookY * 4.5 -
        blendAlert * 9 +
        blendHappy * Math.sin(t * 2.35 * Math.PI - 0.4) * 5.5
      let jawRot =
        0.6 +
        Math.max(0, breath) * 0.9 +
        blendHappy * (2.5 + Math.pow(Math.max(0, Math.sin(t * 4.7 * Math.PI)), 2) * 7.5)

      // Arms (negative = forward/up toward +X, positive = backward toward -X; forearm negative = flex elbow forward)
      let armRRot =
        4 +
        Math.sin(t * 1.65 - 0.6) * 2.8 +
        blendAlert * -38 +
        blendHappy * (-10 + happySway * 16)
      let forearmRRot =
        -7 +
        Math.sin(t * 1.65 - 1.1) * 2.5 +
        blendAlert * -42 +
        blendHappy * (-18 - Math.abs(happySway) * 14)

      let armLRot =
        -5 -
        Math.sin(t * 1.65 - 0.6) * 2.8 +
        blendAlert * -52 +
        blendHappy * (-14 - happySway * 18)
      let forearmLRot =
        -9 -
        Math.sin(t * 1.65 - 1.1) * 2.5 +
        blendAlert * -34 +
        blendHappy * (-16 - Math.abs(happySway) * 12)

      // Ground IK controls (weight 1 = boots welded to ground; weight 0 = airborne free leg pose)
      let ikWeightR = 1
      let ikWeightL = 1
      let footTiltR = 0
      let footTiltL = 0
      let airLegR = 0
      let airShinR = 0
      let airFootR = 0
      let airLegL = 0
      let airShinL = 0
      let airFootL = 0
      let airborneHeight = 0 // >= 0 for ground contact shadow shrinkage
      jetLevel = 0

      // ── 2. Active One-Shot Mechanical Action State Machine ──
      if (action) {
        if (dt > 0) action.elapsed += dt
        const e = action.elapsed

        if (action.kind === 'jump') {
          // 5-phase heavy mechanical jump (total 1.28s):
          // P1 Anticipation [0.00..0.19] | P2 Launch [0.19..0.28] | P3 Airborne [0.28..0.72]
          // P4 Landing Impact [0.72..0.96] | P5 Mechanical Settle [0.96..1.28]
          const baseHipY = hipY
          if (e < 0.19) {
            // P1: Deep grounded squat anticipation, asymmetric arm back-swing, head stays level on target
            const p = smoothstep(e / 0.19)
            hipX = lerp(hipX, -11, p)
            hipY = lerp(baseHipY, 64, p)
            hipRot = lerp(hipRot, -3, p)
            bodyRot = lerp(bodyRot, 16, p)
            headRot = lerp(headRot, -11, p)
            jawRot = lerp(jawRot, 0.5, p)
            armRRot = lerp(armRRot, 46, p)
            forearmRRot = lerp(forearmRRot, -28, p)
            armLRot = lerp(armLRot, 26, p)
            forearmLRot = lerp(forearmLRot, -20, p)
            jetLevel = 0
          } else if (e < 0.28) {
            // P2: Explosive leg extension + upward arm whip + toe push-off (C1 continuous into P3)
            const p = easeInCubic((e - 0.19) / 0.09)
            if (!action.spawnedLaunch && e >= 0.24) {
              action.spawnedLaunch = true
              spawnRing(size.width * 0.48, groundY, 155, 24, '61, 232, 255', 0.34)
            }
            hipX = lerp(-11, 5, p)
            hipY = lerp(64, -5, p)
            hipRot = lerp(-3, 2, p)
            bodyRot = lerp(16, -6, p)
            headRot = lerp(-11, 4, p)
            jawRot = lerp(0.5, 4.5, p)
            // Separate near/far arm arcs cleanly during launch whip
            armRRot = lerp(46, -24, p)
            forearmRRot = lerp(-28, -42, p)
            armLRot = lerp(26, -86, p)
            forearmLRot = lerp(-20, -24, p)
            footTiltR = lerp(0, 16, p)
            footTiltL = lerp(0, 14, p)
            // Release ground lock smoothly with matched leg angle to avoid any takeoff kink
            ikWeightR = 1 - smoothstep((p - 0.72) / 0.28)
            ikWeightL = ikWeightR
            airLegR = -5
            airShinR = 8
            airFootR = 16
            airLegL = -3
            airShinL = 6
            airFootL = 14
            airborneHeight = Math.max(0, -hipY)
            jetLevel = smoothstep((p - 0.55) / 0.45) * 0.9
          } else if (e < 0.72) {
            // P3: Parabolic flight with hang-time apex and asymmetric mechanical tuck
            // Max hipY = -56px (leaves >14px margin inside y=0 canvas top; head rect starts at y=70).
            const u = (e - 0.28) / 0.44 // 0..1 across flight
            const arc = 4 * u * (1 - u) // exact gravity parabola peaking at u=0.5
            const apexHold = Math.pow(arc, 0.88)
            hipX = lerp(5, 3, u)
            hipY = -5 - 51 * apexHold
            airborneHeight = Math.max(0, -hipY)

            // Phase-shifted upper body attitude: tilt slightly back on rise, pitch forward into descent
            const velocityTilt = (u - 0.5) * 2
            hipRot = lerp(2, -4, u)
            bodyRot = lerp(-6, 9, smoothstep(u))
            headRot = -6 + velocityTilt * 10
            jawRot = 2 + apexHold * 5.5

            // Asymmetric heroic silhouette: far left arm sweeps high forward, near right arm braces back/out
            armRRot = lerp(-24, 18, smoothstep(u)) + apexHold * 16
            forearmRRot = -42 - apexHold * 16
            armLRot = lerp(-86, -44, smoothstep(u)) - apexHold * 14
            forearmLRot = -24 - apexHold * 18

            // Smooth knee tuck starting directly from P2 exit angles (no backwards kick!)
            const tuck = Math.sin(clamp(u / 0.82, 0, 1) * Math.PI)
            const reach = smoothstep((u - 0.68) / 0.32)
            ikWeightR = 0
            ikWeightL = 0

            airLegR = lerp(-5, -54, tuck) * (1 - reach) + -14 * reach
            airShinR = lerp(8, 88, tuck) * (1 - reach) + 26 * reach
            airFootR = lerp(16, -12, tuck) * (1 - reach) + -6 * reach

            airLegL = lerp(-3, -32, tuck) * (1 - reach) + -9 * reach
            airShinL = lerp(6, 62, tuck) * (1 - reach) + 18 * reach
            airFootL = lerp(14, -4, tuck) * (1 - reach) + -4 * reach

            jetLevel = Math.max(0, 1 - u * 2.8) * 0.85
          } else if (e < 0.96) {
            // P4: Heavy metallic landing impact + deep knee shock absorption + delayed head/jaw follow-through
            const u = (e - 0.72) / 0.24
            if (!action.spawnedLand) {
              action.spawnedLand = true
              spawnRing(size.width * 0.48, groundY, 195, 28, '226, 232, 240', 0.42)
            }
            const compress = easeOutCubic(Math.min(1, u / 0.58))
            const hold = smoothstep((u - 0.58) / 0.42)
            const shudder = u < 0.2 ? Math.sin(e * 220) * (1 - u / 0.2) * 2.5 : 0

            hipX = lerp(3, -6, compress) + shudder * 0.6
            hipY = lerp(-4, 68, compress) - hold * 6 + shudder
            hipRot = lerp(-3, -4, compress)
            bodyRot = lerp(9, 19, compress) - hold * 3
            const headFollow = easeOutCubic(clamp((u - 0.14) / 0.55, 0, 1))
            headRot = lerp(4, 15, headFollow) - hold * 4
            jawRot = lerp(2, 9.5, Math.sin(clamp(u / 0.65, 0, 1) * Math.PI))
            // Separate near/far arm follow-through cleanly
            armRRot = lerp(18, 36, compress)
            forearmRRot = lerp(-42, -52, compress)
            armLRot = lerp(-44, 12, compress)
            forearmLRot = lerp(-24, -36, compress)
            ikWeightR = 1
            ikWeightL = 1
            airborneHeight = 0
          } else if (e < action.duration) {
            // P5: Hydraulic servo rise with crisp mechanical overshoot and snap-lock
            const u = (e - 0.96) / (action.duration - 0.96)
            const rise = easeOutBack(u, 0.85)
            const settle = smoothstep(u)
            hipX = lerp(-6, hipX, settle)
            hipY = clamp(lerp(62, baseHipY, rise), 3.5, 70)
            hipRot = lerp(-4, hipRot, settle)
            bodyRot = lerp(16, bodyRot, easeOutCubic(u))
            headRot = lerp(11, headRot, smoothstep(clamp((u - 0.12) / 0.88, 0, 1)))
            jawRot = lerp(1.5, jawRot, settle)
            armRRot = lerp(36, armRRot, easeOutCubic(u))
            forearmRRot = lerp(-52, forearmRRot, easeOutCubic(u))
            armLRot = lerp(12, armLRot, easeOutCubic(u))
            forearmLRot = lerp(-36, forearmLRot, easeOutCubic(u))
          } else {
            action = null
          }
        } else if (action.kind === 'wave') {
          // Clean silhouette greeting: far-side left arm extends well outside right contour (+X)
          // so hand waves completely clear of the helmet, with playful head tilt and jaw clicks.
          const total = action.duration
          if (e >= total) {
            action = null
          } else {
            const liftIn = easeOutCubic(clamp(e / 0.24, 0, 1))
            const dropOut = 1 - smoothstep(clamp((e - (total - 0.28)) / 0.28, 0, 1))
            const env = Math.min(liftIn, dropOut)

            // 3 crisp mechanical wave beats with forearm lag
            const waveT = clamp((e - 0.22) / 0.84, 0, 1)
            const waveActive = e > 0.22 && e < total - 0.28 ? Math.sin(waveT * Math.PI) : 0
            const armOsc = Math.sin(waveT * Math.PI * 6) * waveActive
            const forearmOsc = Math.sin(waveT * Math.PI * 6 - 0.75) * waveActive

            // Subtle weight shift left-back while grounded via IK
            hipX = lerp(hipX, -10, env)
            hipY = lerp(hipY, 12, env)
            hipRot = lerp(hipRot, -3.5, env)
            bodyRot = lerp(bodyRot, -5.5, env)
            headRot = lerp(headRot, 14 + armOsc * 2.5, env)
            const greetClick =
              Math.exp(-Math.pow((e - 0.42) / 0.08, 2)) + Math.exp(-Math.pow((e - 0.72) / 0.08, 2))
            jawRot = lerp(jawRot, 1 + greetClick * 9.5, env)

            // Left arm extended outward (-96 deg) + forearm fanned cleanly in open space right of head
            armLRot = lerp(armLRot, -96 + armOsc * 8, env)
            forearmLRot = lerp(forearmLRot, -22 + forearmOsc * 18, env)

            // Right arm braced comfortably for balance
            armRRot = lerp(armRRot, 18, env)
            forearmRRot = lerp(forearmRRot, -32, env)
          }
        } else if (action.kind === 'tap') {
          // Crisp rigid metallic impact stagger -> high-damping servo re-lock (zero jelly scaling)
          const total = action.duration
          if (e >= total) {
            action = null
          } else {
            const u = e / total
            const impact = Math.sin(clamp(u / 0.24, 0, 1) * Math.PI * 0.5)
            const recover = easeOutBack(clamp((u - 0.22) / 0.78, 0, 1), 0.7)
            const weight = u < 0.22 ? impact : 1 - recover
            const snapBuzz = u < 0.16 ? Math.sin(e * 240) * (1 - u / 0.16) * 2.2 : 0

            hipX = lerp(hipX, -14, weight) + snapBuzz
            hipY = lerp(hipY, 26, weight)
            hipRot = lerp(hipRot, -4.5, weight)
            bodyRot = lerp(bodyRot, -13, weight)
            // Head whips back harder with slight lag, jaw jarred open then clicks shut
            const headLag = u < 0.28 ? easeOutCubic(u / 0.28) : 1 - easeOutBack(clamp((u - 0.28) / 0.72, 0, 1), 0.9)
            headRot = lerp(headRot, -21, headLag) + snapBuzz * 1.4
            jawRot = lerp(jawRot, 12.5, Math.sin(clamp(u / 0.48, 0, 1) * Math.PI))
            // Arms flare instinctively to catch balance
            armRRot = lerp(armRRot, 30, weight)
            forearmRRot = lerp(forearmRRot, -36, weight)
            armLRot = lerp(armLRot, -34, weight)
            forearmLRot = lerp(forearmLRot, -24, weight)
          }
        }
      }

      // ── 3. Solve 2-Bone Leg IK for both legs (0px ground slide when grounded) ──
      let legRRot = airLegR
      let shinRRot = airShinR
      let footRRot = airFootR
      let legLRot = airLegL
      let shinLRot = airShinL
      let footLRot = airFootL

      if (legR) {
        const ikR = solveLegIK(legR, hipRest, hipX, hipY, hipRot, legR.ankleRest, footTiltR)
        legRRot = lerp(airLegR, ikR.legRot, ikWeightR)
        shinRRot = lerp(airShinR, ikR.shinRot, ikWeightR)
        footRRot = lerp(airFootR, ikR.footRot, ikWeightR)
      }
      if (legL) {
        const ikL = solveLegIK(legL, hipRest, hipX, hipY, hipRot, legL.ankleRest, footTiltL)
        legLRot = lerp(airLegL, ikL.legRot, ikWeightL)
        shinLRot = lerp(airShinL, ikL.shinRot, ikWeightL)
        footLRot = lerp(airFootL, ikL.footRot, ikWeightL)
      }

      // ── 4. Apply strictly rigid TRS (scaleX = 1, scaleY = 1 everywhere) ──
      const pose = puppet.setPose({
        timeMs,
        bones: {
          hip: { x: hipX, y: hipY, rotation: hipRot, scaleX: 1, scaleY: 1 },
          body: { rotation: bodyRot, scaleX: 1, scaleY: 1 },
          head: { rotation: headRot, scaleX: 1, scaleY: 1 },
          jaw: { rotation: clamp(jawRot, -0.5, 16), scaleX: 1, scaleY: 1 },
          arm_r: { rotation: armRRot, scaleX: 1, scaleY: 1 },
          forearm_r: { rotation: forearmRRot, scaleX: 1, scaleY: 1 },
          arm_l: { rotation: armLRot, scaleX: 1, scaleY: 1 },
          forearm_l: { rotation: forearmLRot, scaleX: 1, scaleY: 1 },
          leg_r: { rotation: legRRot, scaleX: 1, scaleY: 1 },
          shin_r: { rotation: shinRRot, scaleX: 1, scaleY: 1 },
          foot_r: { rotation: footRRot, scaleX: 1, scaleY: 1 },
          leg_l: { rotation: legLRot, scaleX: 1, scaleY: 1 },
          shin_l: { rotation: shinLRot, scaleX: 1, scaleY: 1 },
          foot_l: { rotation: footLRot, scaleX: 1, scaleY: 1 },
        },
      })

      // Advance FX timers
      if (dt > 0) {
        for (let i = shockRings.length - 1; i >= 0; i--) {
          shockRings[i].age += dt
          if (shockRings[i].age >= shockRings[i].duration) shockRings.splice(i, 1)
        }
        for (let i = arcs.length - 1; i >= 0; i--) {
          arcs[i].age += dt
          if (arcs[i].age >= arcs[i].duration) arcs.splice(i, 1)
        }
      }

      // ── 5. Restraint, crisp mechanical coaxial FX (no blurry jelly aura) ──
      if (back?.ctx2d) {
        const g = back.ctx2d
        g.clearRect(0, 0, size.width, size.height)
        g.save()

        // Crisp perspective contact shadow anchored to ground plane
        const shadowFactor = clamp(1 - airborneHeight / 170, 0.42, 1)
        const shadowCenterX = (legR && legL ? (legR.ankleRest[0] + legL.ankleRest[0]) * 0.5 + 42 : size.width * 0.5)
        const shadowGrad = g.createRadialGradient(
          shadowCenterX,
          groundY,
          12 * shadowFactor,
          shadowCenterX,
          groundY,
          145 * shadowFactor,
        )
        shadowGrad.addColorStop(0, `rgba(0, 0, 0, ${(0.34 * shadowFactor).toFixed(3)})`)
        shadowGrad.addColorStop(0.7, `rgba(0, 0, 0, ${(0.14 * shadowFactor).toFixed(3)})`)
        shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
        g.save()
        g.translate(shadowCenterX, groundY)
        g.scale(1, 0.16)
        g.fillStyle = shadowGrad
        g.beginPath()
        g.arc(0, 0, 145 * shadowFactor, 0, Math.PI * 2)
        g.fill()
        g.restore()

        // Ground landing / launch shockwave rings
        for (const ring of shockRings) {
          const u = clamp(ring.age / ring.duration, 0, 1)
          const expand = easeOutCubic(u)
          const alpha = (1 - u) * 0.62
          g.strokeStyle = `rgba(${ring.color}, ${alpha.toFixed(3)})`
          g.lineWidth = Math.max(1, 2.6 * (1 - u))
          g.beginPath()
          g.ellipse(ring.x, ring.y, 46 + ring.maxRx * expand, 6 + ring.maxRy * expand, 0, 0, Math.PI * 2)
          g.stroke()
        }

        // Subtle tactical reticle arc in alert mode only
        if (blendAlert > 0.05) {
          const head = pose.bones?.find((b) => b.boneId === 'head')
          if (head) {
            const cx = (head.start[0] + head.end[0]) * 0.5
            const cy = (head.start[1] + head.end[1]) * 0.5 - 12
            const sweep = t * 1.4
            g.strokeStyle = `rgba(251, 146, 60, ${(0.28 * blendAlert).toFixed(3)})`
            g.lineWidth = 1.5
            g.beginPath()
            g.arc(cx, cy, 178, sweep, sweep + 0.85)
            g.stroke()
            g.beginPath()
            g.arc(cx, cy, 178, sweep + Math.PI, sweep + Math.PI + 0.85)
            g.stroke()
          }
        }

        g.restore()
      }

      if (front?.ctx2d) {
        const g = front.ctx2d
        g.clearRect(0, 0, size.width, size.height)
        g.save()

        // Crisp cold-blue thruster jets under both boots only when clear of floor (never piercing groundY)
        if (jetLevel > 0.02) {
          for (const footId of ['foot_r', 'foot_l']) {
            const foot = pose.bones?.find((b) => b.boneId === footId)
            if (!foot) continue
            const mx = (foot.start[0] + foot.end[0]) * 0.48
            const my = Math.max(foot.start[1], foot.end[1]) + 16
            const clearance = groundY - my
            if (clearance < 8) continue
            const desiredLen = (24 + 42 * jetLevel) * (0.9 + 0.1 * Math.sin(t * 95))
            const plumeLen = Math.min(desiredLen, clearance)
            const grad = g.createLinearGradient(mx, my, mx, my + plumeLen)
            grad.addColorStop(0, `rgba(224, 252, 255, ${(0.9 * jetLevel).toFixed(3)})`)
            grad.addColorStop(0.5, `rgba(56, 219, 255, ${(0.62 * jetLevel).toFixed(3)})`)
            grad.addColorStop(1, 'rgba(56, 219, 255, 0)')
            g.fillStyle = grad
            g.beginPath()
            g.moveTo(mx - 12 * jetLevel, my)
            g.lineTo(mx + 12 * jetLevel, my)
            g.lineTo(mx, my + plumeLen)
            g.closePath()
            g.fill()
          }
        }

        // Sharp electric spark arcs on metallic tap impact
        for (const arc of arcs) {
          const u = clamp(arc.age / arc.duration, 0, 1)
          const alpha = 1 - u
          g.strokeStyle = `rgba(210, 250, 255, ${(alpha * 0.98).toFixed(3)})`
          g.lineWidth = 2.8 * (1 - u * 0.45)
          g.lineCap = 'round'
          g.lineJoin = 'round'
          g.beginPath()
          g.moveTo(arc.pts[0][0], arc.pts[0][1])
          for (let i = 1; i < arc.pts.length; i++) g.lineTo(arc.pts[i][0], arc.pts[i][1])
          g.stroke()
        }

        g.restore()
      }
    },
    destroy() {
      shockRings = []
      arcs = []
      clearLayers()
    },
  }
}
