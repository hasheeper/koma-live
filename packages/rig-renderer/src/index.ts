export { mountLiveRig, mountPublished, type LivePoseInput, type LiveRigPlayer, type LiveRigSource } from './game.js'
export * from './performance.js'
export { mountCharacter } from './character.js'
import type { CanvasSize, PixelRect } from '@koma-rig/rig-core'
import { Application, MeshPlane, Texture } from 'pixi.js'

/** @deprecated Bounds-only host adapter. Use mountCharacter for a layered character. */
export async function mount(target: HTMLElement) {
  const canvas = target.tagName === 'CANVAS' ? target as HTMLCanvasElement : undefined
  const app = new Application()
  await app.init({
    preference: 'webgl',
    canvas,
    backgroundAlpha: 0,
    width: 1,
    height: 1,
    autoStart: false,
  })

  const selection = new MeshPlane({ texture: Texture.WHITE, verticesX: 2, verticesY: 2 })
  selection.alpha = 0.65
  app.stage.addChild(selection)
  if (!canvas) target.appendChild(app.canvas)
  return {
    canvas: app.canvas,
    update(canvas: CanvasSize, rect?: PixelRect, tint = 0x7dd3fc) {
      const scale = Math.min(720 / canvas.width, 480 / canvas.height)
      app.renderer.resize(Math.max(1, Math.round(canvas.width * scale)),
                          Math.max(1, Math.round(canvas.height * scale)))
      selection.tint = tint
      selection.visible = Boolean(rect)
      if (rect) {
        const [x, y, width, height] = rect
        selection.position.set(x * scale, y * scale)
        selection.width = width * scale
        selection.height = height * scale
      }
      app.render()
    },
    destroy() {
      app.destroy({ removeView: !canvas }, { children: true })
    },
  }
}
