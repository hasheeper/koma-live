import {
  Application,
  Container,
  Graphics,
  ImageSource,
  Matrix,
  Mesh,
  MeshGeometry,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
} from 'pixi.js'
import type { WebGLRenderer } from 'pixi.js'
import type { Pose, SliceManifest } from '@koma-rig/rig-core'

/** A flat render list. All deformation, parenting and time belong to rig-core. */
export async function mountCharacter(
  host: HTMLElement,
  manifest: SliceManifest,
  files: ReadonlyMap<string, Blob>,
) {
  if (manifest.format !== 'koma-rig.slices.v2')
    throw new Error('逐层姿势预览需要 sRGB v2 切片，v1 可通过 rig verify-slices 离线复原')
  const canvas = host instanceof HTMLCanvasElement ? host : undefined
  const app = new Application<WebGLRenderer>()
  await app.init({
    canvas,
    width: manifest.canvas.width,
    height: manifest.canvas.height,
    preference: 'webgl',
    autoStart: false,
    backgroundAlpha: 0,
    antialias: false,
    resolution: 1,
  })
  const images = new Map<string, Texture>()
  // Keep fractional edge coverage between overlapping passes until the final RGBA8 presentation.
  const format = app.renderer.context.extensions.colorBufferFloat ? 'rgba16float' : 'rgba8unorm'
  const flat = new Container()
  const scene = RenderTexture.create({ ...manifest.canvas, format })
  app.stage.addChild(new Sprite(scene))
  const passes: { container: Container; target: RenderTexture }[] = []
  const geometries: MeshGeometry[] = []
  const records = new Map<
    string,
    {
      mesh: Mesh<MeshGeometry>
      drawObject: Sprite | Mesh<MeshGeometry>
      opacity: number
      erase?: Mesh<MeshGeometry>
      peek?: Mesh<MeshGeometry>
      clip?: Graphics
      topology?: number[]
    }
  >()
  async function texture(path: string) {
    const cached = images.get(path)
    if (cached) return cached
    const blob = files.get(path)
    if (!blob) throw new Error('缺少 ' + path)
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const source = new Texture({
      source: new ImageSource({ resource: bitmap, alphaMode: 'no-premultiply-alpha', scaleMode: 'nearest' }),
    })
    const upload = new Sprite(source)
    const tex = RenderTexture.create({ width: bitmap.width, height: bitmap.height, format })
    images.set(path, tex)
    // One texel per fragment at native size. NPM blending against zero premultiplies
    // once into the float texture, before any deformation or bilinear filtering.
    try {
      app.renderer.render({ container: upload, target: tex, clear: true })
    } finally {
      upload.destroy()
      source.destroy(true)
      bitmap.close()
    }
    return tex
  }
  function destroy() {
    app.destroy({ removeView: !canvas }, { children: true })
    flat.destroy({ children: true })
    scene.destroy(true)
    for (const p of passes) {
      p.container.destroy({ children: true })
      p.target.destroy(true)
    }
    for (const g of geometries) g.destroy()
    for (const tex of images.values()) tex.destroy(true)
  }
  try {
    const memberships = new Map(
      (manifest.gelGroups ?? []).flatMap((g) => g.members.map((m) => [m.layerId, { g, m }] as const)),
    )
    // Decode independent slices concurrently in bounded batches. Commit mesh draw order below.
    const paths = [...new Set([...manifest.layers.map(l => l.texture), ...[...memberships.values()].map(v => v.m.coverage)])]
    for (let i = 0; i < paths.length; i += 8) {
      const decoded = await Promise.allSettled(paths.slice(i, i + 8).map(texture))
      for (const result of decoded) if (result.status === 'rejected') throw result.reason
    }
    flat.sortableChildren = true
    let groupSprite: Sprite | undefined
    let destination = flat
    for (const l of manifest.layers) {
      const member = memberships.get(l.layerId)
      if (member && member.g.members[0] === member.m) {
        const pass = {
          container: new Container(),
          target: RenderTexture.create({ ...manifest.canvas, format }),
        }
        passes.push(pass)
        destination = pass.container
        const sprite = new Sprite(pass.target)
        sprite.alpha = member.g.opacity
        groupSprite = sprite
        flat.addChild(sprite)
      }
      const [, , w, h] = l.rect
      const geo = new MeshGeometry({
        positions: new Float32Array([0, 0, w, 0, 0, h, w, h]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
      })
      geometries.push(geo)
      let erase: Mesh<MeshGeometry> | undefined
      if (member) {
        erase = new Mesh({ geometry: geo, texture: images.get(member.m.coverage)! })
        erase.blendMode = 'erase'
        destination.addChild(erase)
      }
      const mesh = new Mesh({ geometry: geo, texture: images.get(l.texture)! })
      if (
        mesh.texture.width !== w ||
        mesh.texture.height !== h ||
        (erase && (erase.texture.width !== w || erase.texture.height !== h))
      )
        throw new Error(l.layerId + ' 纹理与切片尺寸不符')
      mesh.alpha = l.opacity
      if (member) mesh.blendMode = 'add'
      destination.addChild(mesh)
      records.set(l.layerId, { mesh, drawObject: member ? groupSprite! : mesh, opacity: l.opacity, erase })
      if (member && member.g.members.at(-1) === member.m) destination = flat
    }
    if (!canvas) host.appendChild(app.canvas)
  } catch (error) {
    destroy()
    throw error
  }
  function update(pose: Pose) {
    const order = new Map(pose.parts.map((p, i) => [p.layerId, i]))
    for (const [index, p] of pose.parts.entries()) {
      const r = records.get(p.layerId)
      if (!r) throw new Error('未知渲染部件 ' + p.layerId)
      r.drawObject.zIndex = index
      const matrix = new Matrix(...p.matrix)
      r.mesh.setFromMatrix(matrix)
      r.mesh.visible = p.visible
      r.mesh.alpha = r.opacity * (p.opacity ?? 1)
      if (r.erase) {
        r.erase.setFromMatrix(matrix)
        r.erase.visible = p.visible
      }
      if (p.geometry) {
        const g = r.mesh.geometry
        if (r.topology !== p.geometry.indices) {
          g.positions = new Float32Array(p.geometry.vertices)
          g.uvs = new Float32Array(p.geometry.uv)
          g.indices = new Uint32Array(p.geometry.indices)
          r.topology = p.geometry.indices
        } else {
          g.positions.set(p.geometry.vertices)
          g.getBuffer('aPosition').update()
        }
      } else if (r.topology) {
        const { width: w, height: h } = r.mesh.texture
        r.mesh.geometry.positions = new Float32Array([0, 0, w, 0, 0, h, w, h])
        r.mesh.geometry.uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
        r.mesh.geometry.indices = new Uint32Array([0, 1, 2, 1, 3, 2])
        r.topology = undefined
      }
      if (p.mask) {
        if (!r.clip) {
          r.clip = new Graphics()
          r.mesh.parent!.addChild(r.clip)
          r.mesh.mask = r.clip
          if (r.erase) r.erase.mask = r.clip
        }
        r.clip.clear().poly(p.mask.flat()).fill(0xffffff)
      } else if (r.clip) {
        r.mesh.mask = null
        if (r.erase) r.erase.mask = null
        if (r.peek) r.peek.mask = null
        r.clip.destroy()
        r.clip = undefined
      }
      // Optional ACGN translucent peek-through pass (shares live geometry + texture)
      if (p.peekOpacity && p.peekOpacity > 0) {
        if (!r.peek) {
          r.peek = new Mesh({ geometry: r.mesh.geometry, texture: r.mesh.texture })
          flat.addChild(r.peek)
        }
        const anchorIndex = p.peekAfter !== undefined ? order.get(p.peekAfter) : undefined
        r.peek.zIndex = (anchorIndex !== undefined ? anchorIndex + 0.5 : pose.parts.length) + index * 1e-4
        r.peek.setFromMatrix(matrix)
        r.peek.visible = p.visible
        r.peek.alpha = r.opacity * (p.opacity ?? 1) * p.peekOpacity
        if (r.clip) r.peek.mask = r.clip
      } else if (r.peek) {
        r.peek.visible = false
      }
    }
    for (const pass of passes)
      app.renderer.render({ container: pass.container, target: pass.target, clear: true })
    app.renderer.render({ container: flat, target: scene, clear: true })
    app.render()
  }
  function pixels() {
    return app.renderer.extract.pixels({
      target: app.stage,
      frame: new Rectangle(0, 0, manifest.canvas.width, manifest.canvas.height),
    }).pixels
  }
  return { canvas: app.canvas, update, pixels, destroy }
}
