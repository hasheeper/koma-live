// Single-file self-contained ES Module (koma-rig.performance.v1)
export const meta = {
  format: 'koma-rig.performance.v1',
  title: '纸带 · 骨链柔风',
  author: 'Koma Live',
  states: ['breeze', 'gust'],
  triggers: ['flick'],
  layers: { back: '2d', front: '2d' },
}

export default function createPerformance(ctx) {
  const { puppet, size, back, front } = ctx
  let state = 'breeze'
  let flick = 0
  let flickVel = 0
  let gustBlend = 0
  let pointerY = 0
  let trail = []

  function clearLayers() {
    back?.ctx2d?.clearRect(0, 0, size.width, size.height)
    front?.ctx2d?.clearRect(0, 0, size.width, size.height)
  }

  return {
    setState(next) {
      state = next
    },
    trigger(name) {
      if (name === 'flick') flickVel += 125
    },
    reset() {
      flick = 0
      flickVel = 0
      gustBlend = state === 'gust' ? 1 : 0
      pointerY = 0
      trail = []
      puppet.reset()
      clearLayers()
    },
    update({ timeMs, dtMs, pointer }) {
      const t = timeMs / 1000
      const dt = Math.min(dtMs, 50) / 1000

      gustBlend += ((state === 'gust' ? 1 : 0) - gustBlend) * (1 - Math.exp(-5 * dt))
      flickVel += (-140 * flick - 10 * flickVel) * dt
      flick += flickVel * dt

      const targetPy = pointer.inside ? Math.max(-1, Math.min(1, pointer.ny)) : 0
      pointerY += (targetPy - pointerY) * (1 - Math.exp(-7 * dt))

      const amp = 1 + gustBlend * 0.65
      const baseRot = Math.sin(t * 2.1) * 6.5 * amp + pointerY * 5 + flick * 0.28
      const tipRot = Math.sin(t * 2.1 - 0.85) * 11 * amp + pointerY * 7 + flick * 0.45

      const pose = puppet.setPose({
        timeMs,
        bones: {
          base: { y: Math.sin(t * 1.4) * 3.5, rotation: baseRot },
          tip: { rotation: tipRot },
        },
      })

      const tipBone = pose.bones?.find((b) => b.boneId === 'tip')
      if (tipBone && dt >= 0) {
        trail.push({ x: tipBone.end[0], y: tipBone.end[1] })
        if (trail.length > 18) trail.shift()
      }

      if (back?.ctx2d) {
        const g = back.ctx2d
        g.clearRect(0, 0, size.width, size.height)
        g.save()
        g.strokeStyle = `rgba(61, 242, 255, ${(0.08 + gustBlend * 0.1).toFixed(3)})`
        g.lineWidth = 1
        for (let i = 0; i < 3; i++) {
          const y = 26 + i * 38 + Math.sin(t * 1.8 + i) * 4
          g.beginPath()
          g.moveTo(8, y)
          g.quadraticCurveTo(size.width * 0.5, y + Math.sin(t * 2.5 + i) * 8, size.width - 8, y)
          g.stroke()
        }
        g.restore()
      }

      if (front?.ctx2d) {
        const g = front.ctx2d
        g.clearRect(0, 0, size.width, size.height)
        if (trail.length > 1) {
          g.save()
          for (let i = 1; i < trail.length; i++) {
            const alpha = (i / trail.length) * 0.55
            g.strokeStyle = `rgba(110, 244, 255, ${alpha.toFixed(3)})`
            g.lineWidth = 1.2 + (i / trail.length) * 1.8
            g.beginPath()
            g.moveTo(trail[i - 1].x, trail[i - 1].y)
            g.lineTo(trail[i].x, trail[i].y)
            g.stroke()
          }
          g.restore()
        }
      }
    },
    destroy() {
      trail = []
      clearLayers()
    },
  }
}
