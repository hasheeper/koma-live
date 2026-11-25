import {
  Application,
  BlurFilter,
  ColorMatrixFilter,
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
  const texScale = manifest.textureScale ?? 1
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
    resolution: texScale,
  })
  const images = new Map<string, Texture>()
  // Keep float fractional precision strictly for gelGroups passes (where Knockout blending needs it);
  // regular 8-bit PNG slices use rgba8unorm to halve GPU VRAM footprint with zero visual loss.
  const floatFormat = app.renderer.context.extensions.colorBufferFloat ? 'rgba16float' : 'rgba8unorm'
  const hasGelGroups = Boolean(manifest.gelGroups?.length)
  const sceneFormat = hasGelGroups ? floatFormat : 'rgba8unorm'
  const gelLayerIds = new Set((manifest.gelGroups ?? []).flatMap((g) => g.members.map((m) => m.layerId)))
  const gelPaths = new Set<string>([
    ...manifest.layers.filter((l) => gelLayerIds.has(l.layerId)).map((l) => l.texture),
    ...(manifest.gelGroups ?? []).flatMap((g) => g.members.map((m) => m.coverage)),
  ])
  const flat = new Container()
  const scene = RenderTexture.create({ ...manifest.canvas, resolution: texScale, format: sceneFormat })
  app.stage.addChild(new Sprite(scene))
  const passes: { container: Container; target: RenderTexture }[] = []
  const clipMasks = new Map<
    string,
    { container: Container; proxy: Mesh<MeshGeometry>; target: RenderTexture; sprite: Sprite }
  >()
  interface ShadowPass {
    clipRoot: Container
    maskedHolder: Container
    casterContainer: Container
    casterProxies: Map<string, Mesh<MeshGeometry>>
    silhouetteFilter: ColorMatrixFilter
    blurFilter?: BlurFilter
    clipMaskSprite: Sprite
    target: RenderTexture
    sprite: Sprite
    maskContainer: Container
    maskProxies: Map<string, Mesh<MeshGeometry>>
    maskTarget: RenderTexture
    capW: number
    capH: number
  }
  const shadowPasses: ShadowPass[] = []
  const geometries: MeshGeometry[] = []
  const records = new Map<
    string,
    {
      mesh: Mesh<MeshGeometry>
      drawObject: Sprite | Mesh<MeshGeometry>
      opacity: number
      width: number
      height: number
      erase?: Mesh<MeshGeometry>
      peek?: Mesh<MeshGeometry>
      clip?: Graphics
      clipToId?: string
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
    const tex = RenderTexture.create({
      width: bitmap.width,
      height: bitmap.height,
      format: gelPaths.has(path) ? floatFormat : 'rgba8unorm',
    })
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
    for (const r of records.values()) {
      r.mesh.mask = null
      if (r.erase) r.erase.mask = null
      if (r.peek) r.peek.mask = null
    }
    for (const sp of shadowPasses) {
      sp.maskedHolder.mask = null
      sp.casterContainer.filters = null
      sp.clipRoot.destroy({ children: true })
      sp.silhouetteFilter.destroy()
      if (sp.blurFilter) sp.blurFilter.destroy()
      sp.sprite.destroy()
      sp.target.destroy(true)
      sp.maskContainer.destroy({ children: true })
      sp.maskTarget.destroy(true)
    }
    shadowPasses.length = 0
    for (const cm of clipMasks.values()) {
      cm.container.destroy({ children: true })
      cm.sprite.destroy()
      cm.target.destroy(true)
    }
    clipMasks.clear()
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
          target: RenderTexture.create({ ...manifest.canvas, resolution: texScale, format: floatFormat }),
        }
        passes.push(pass)
        destination = pass.container
        const sprite = new Sprite(pass.target)
        sprite.alpha = member.g.opacity
        groupSprite = sprite
        flat.addChild(sprite)
      }
      const [, , w, h] = l.rect
      const expectedW = Math.max(1, Math.round(w * texScale))
      const expectedH = Math.max(1, Math.round(h * texScale))
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
        mesh.texture.width !== expectedW ||
        mesh.texture.height !== expectedH ||
        (erase && (erase.texture.width !== expectedW || erase.texture.height !== expectedH))
      )
        throw new Error(l.layerId + ' 纹理与切片尺寸不符')
      mesh.alpha = l.opacity
      if (member) mesh.blendMode = 'add'
      destination.addChild(mesh)
      records.set(l.layerId, {
        mesh,
        drawObject: member ? groupSprite! : mesh,
        opacity: l.opacity,
        width: w,
        height: h,
        erase,
      })
      if (member && member.g.members.at(-1) === member.m) destination = flat
    }
    if (!canvas) host.appendChild(app.canvas)
  } catch (error) {
    destroy()
    throw error
  }
  function getOrCreateClipMask(targetLayerId: string) {
    let entry = clipMasks.get(targetLayerId)
    if (entry) return entry
    const src = records.get(targetLayerId)
    if (!src) throw new Error('未知裁切目标图层 ' + targetLayerId)
    const proxy = new Mesh({ geometry: src.mesh.geometry, texture: src.mesh.texture })
    const container = new Container()
    container.addChild(proxy)
    const target = RenderTexture.create({ ...manifest.canvas, resolution: texScale, format: 'rgba8unorm' })
    const sprite = new Sprite(target)
    sprite.renderable = false
    sprite.zIndex = -1
    flat.addChild(sprite)
    entry = { container, proxy, target, sprite }
    clipMasks.set(targetLayerId, entry)
    return entry
  }
  function getOrCreateShadowPass(index: number, reqW: number, reqH: number): ShadowPass {
    while (shadowPasses.length <= index) {
      const capW = Math.min(manifest.canvas.width, Math.max(64, reqW + 64))
      const capH = Math.min(manifest.canvas.height, Math.max(64, reqH + 64))
      const clipRoot = new Container()
      const maskedHolder = new Container()
      const casterContainer = new Container()
      const silhouetteFilter = new ColorMatrixFilter()
      silhouetteFilter.matrix = [
        0, 0, 0, 0, 1,
        0, 0, 0, 0, 1,
        0, 0, 0, 0, 1,
        0, 0, 0, 1, 0,
      ]
      const maskContainer = new Container()
      const maskTarget = RenderTexture.create({ width: capW, height: capH, resolution: texScale, format: 'rgba8unorm' })
      const clipMaskSprite = new Sprite(maskTarget)
      clipMaskSprite.renderable = false
      clipRoot.addChild(clipMaskSprite)
      maskedHolder.addChild(casterContainer)
      maskedHolder.setMask({ mask: clipMaskSprite, channel: 'alpha' })
      clipRoot.addChild(maskedHolder)
      const target = RenderTexture.create({ width: capW, height: capH, resolution: texScale, format: 'rgba8unorm' })
      const sprite = new Sprite(target)
      sprite.visible = false
      flat.addChild(sprite)
      shadowPasses.push({
        clipRoot,
        maskedHolder,
        casterContainer,
        casterProxies: new Map(),
        silhouetteFilter,
        clipMaskSprite,
        target,
        sprite,
        maskContainer,
        maskProxies: new Map(),
        maskTarget,
        capW,
        capH,
      })
    }
    const sp = shadowPasses[index]!
    if (reqW > sp.capW || reqH > sp.capH) {
      sp.capW = Math.min(manifest.canvas.width, Math.max(sp.capW, reqW + 64))
      sp.capH = Math.min(manifest.canvas.height, Math.max(sp.capH, reqH + 64))
      const nextMask = RenderTexture.create({ width: sp.capW, height: sp.capH, resolution: texScale, format: 'rgba8unorm' })
      const nextTarget = RenderTexture.create({ width: sp.capW, height: sp.capH, resolution: texScale, format: 'rgba8unorm' })
      sp.clipMaskSprite.texture = nextMask
      sp.sprite.texture = nextTarget
      sp.maskTarget.destroy(true)
      sp.target.destroy(true)
      sp.maskTarget = nextMask
      sp.target = nextTarget
    }
    return sp
  }
  function computeLayerWorldBounds(
    part: Pose['parts'][number],
    width: number,
    height: number,
    out: [number, number, number, number],
  ) {
    const [a, b, c, d, tx, ty] = part.matrix
    const g = part.geometry
    if (g && g.vertices.length >= 2) {
      const v = g.vertices
      for (let i = 0; i < v.length; i += 2) {
        const lx = v[i]!
        const ly = v[i + 1]!
        const wx = a * lx + c * ly + tx
        const wy = b * lx + d * ly + ty
        if (wx < out[0]) out[0] = wx
        if (wy < out[1]) out[1] = wy
        if (wx > out[2]) out[2] = wx
        if (wy > out[3]) out[3] = wy
      }
      return
    }
    const corners: readonly [number, number][] = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ]
    for (const [lx, ly] of corners) {
      const wx = a * lx + c * ly + tx
      const wy = b * lx + d * ly + ty
      if (wx < out[0]) out[0] = wx
      if (wy < out[1]) out[1] = wy
      if (wx > out[2]) out[2] = wx
      if (wy > out[3]) out[3] = wy
    }
  }
  function update(pose: Pose) {
    const order = new Map(pose.parts.map((p, i) => [p.layerId, i]))
    const byPart = new Map(pose.parts.map((p) => [p.layerId, p]))
    const activeClipTargets = new Set<string>()
    for (const [index, p] of pose.parts.entries()) {
      const r = records.get(p.layerId)
      if (!r) throw new Error('未知渲染部件 ' + p.layerId)
      r.drawObject.zIndex = index
      const matrix = new Matrix(...p.matrix)
      const tint = p.tint ?? 0xffffff
      r.mesh.setFromMatrix(matrix)
      r.mesh.visible = p.visible
      r.mesh.alpha = r.opacity * (p.opacity ?? 1)
      r.mesh.tint = tint
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
        const w = r.width,
          h = r.height
        r.mesh.geometry.positions = new Float32Array([0, 0, w, 0, 0, h, w, h])
        r.mesh.geometry.uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
        r.mesh.geometry.indices = new Uint32Array([0, 1, 2, 1, 3, 2])
        r.topology = undefined
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
        r.peek.tint = tint
      } else if (r.peek) {
        r.peek.visible = false
      }
      if (p.mask) {
        if (r.clipToId) {
          r.mesh.mask = null
          if (r.erase) r.erase.mask = null
          if (r.peek) r.peek.mask = null
          r.clipToId = undefined
        }
        if (!r.clip) {
          r.clip = new Graphics()
          r.mesh.parent!.addChild(r.clip)
          r.mesh.mask = r.clip
          if (r.erase) r.erase.mask = r.clip
        }
        r.clip.clear().poly(p.mask.flat()).fill(0xffffff)
        if (r.peek) r.peek.mask = r.clip
      } else {
        if (r.clip) {
          r.mesh.mask = null
          if (r.erase) r.erase.mask = null
          if (r.peek) r.peek.mask = null
          r.clip.destroy()
          r.clip = undefined
        }
        if (p.clipTo) {
          activeClipTargets.add(p.clipTo)
          const cm = getOrCreateClipMask(p.clipTo)
          if (r.clipToId !== p.clipTo) {
            r.mesh.setMask({ mask: cm.sprite, channel: 'alpha' })
            if (r.erase) r.erase.setMask({ mask: cm.sprite, channel: 'alpha' })
            r.clipToId = p.clipTo
          }
          if (r.peek && r.peek.mask !== cm.sprite) {
            r.peek.setMask({ mask: cm.sprite, channel: 'alpha' })
          }
        } else if (r.clipToId) {
          r.mesh.mask = null
          if (r.erase) r.erase.mask = null
          if (r.peek) r.peek.mask = null
          r.clipToId = undefined
        }
      }
    }
    // Render live deformed Alpha silhouettes for all active clipTo targets
    for (const targetId of activeClipTargets) {
      const cm = clipMasks.get(targetId)!
      const src = records.get(targetId)!
      const srcPart = byPart.get(targetId)!
      cm.proxy.setFromMatrix(new Matrix(...srcPart.matrix))
      cm.proxy.visible = srcPart.visible
      cm.proxy.alpha = Math.min(1, src.opacity * (srcPart.opacity ?? 1))
      app.renderer.render({ container: cm.container, target: cm.target, clear: true })
    }
    // Tight-bounds crisp 2D cel cast shadows (renders ONLY the receiver AABB -> ~25x less GPU fill-rate!)
    const shadows = pose.shadows ?? []
    for (let si = 0; si < shadows.length; si++) {
      const sh = shadows[si]!
      const shadowOpacity = sh.opacity ?? 0.2
      if (shadowOpacity <= 1e-4) {
        if (shadowPasses[si]) shadowPasses[si]!.sprite.visible = false
        continue
      }
      const visReceivers: string[] = []
      let maxReceiverIdx = -1
      const recBounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const rid of sh.receivers) {
        const src = records.get(rid)
        const part = byPart.get(rid)
        if (!src || !part || !part.visible) continue
        if (src.opacity * (part.opacity ?? 1) <= 1e-4) continue
        visReceivers.push(rid)
        computeLayerWorldBounds(part, src.width, src.height, recBounds)
        const idx = order.get(rid)
        if (idx !== undefined && idx > maxReceiverIdx) maxReceiverIdx = idx
      }
      if (!visReceivers.length || recBounds[2] <= recBounds[0] || recBounds[3] <= recBounds[1]) {
        if (shadowPasses[si]) shadowPasses[si]!.sprite.visible = false
        continue
      }

      const blur = sh.blur ?? 0
      const pad = Math.ceil(blur * 2 + 4)
      const rx0 = Math.max(0, Math.floor(recBounds[0]) - pad)
      const ry0 = Math.max(0, Math.floor(recBounds[1]) - pad)
      const rx1 = Math.min(manifest.canvas.width, Math.ceil(recBounds[2]) + pad)
      const ry1 = Math.min(manifest.canvas.height, Math.ceil(recBounds[3]) + pad)
      const rw = rx1 - rx0
      const rh = ry1 - ry0
      if (rw <= 0 || rh <= 0) {
        if (shadowPasses[si]) shadowPasses[si]!.sprite.visible = false
        continue
      }

      const sp = getOrCreateShadowPass(si, rw, rh)
      for (const proxy of sp.casterProxies.values()) proxy.visible = false
      let minCasterIdx = Infinity
      let hasCaster = false
      for (const cid of sh.casters) {
        const src = records.get(cid)
        const part = byPart.get(cid)
        if (!src || !part || !part.visible) continue
        const effAlpha = Math.min(1, src.opacity * (part.opacity ?? 1))
        if (effAlpha <= 1e-4) continue
        let proxy = sp.casterProxies.get(cid)
        if (!proxy) {
          proxy = new Mesh({ geometry: src.mesh.geometry, texture: src.mesh.texture })
          sp.casterProxies.set(cid, proxy)
          sp.casterContainer.addChild(proxy)
        }
        const m = new Matrix(...part.matrix)
        m.tx += sh.offset[0] - rx0
        m.ty += sh.offset[1] - ry0
        proxy.setFromMatrix(m)
        proxy.visible = true
        proxy.alpha = effAlpha
        hasCaster = true
        const idx = order.get(cid)
        if (idx !== undefined && idx < minCasterIdx) minCasterIdx = idx
      }
      if (!hasCaster) {
        sp.sprite.visible = false
        continue
      }

      for (const mp of sp.maskProxies.values()) mp.visible = false
      for (const rid of visReceivers) {
        const src = records.get(rid)!
        const part = byPart.get(rid)!
        let mp = sp.maskProxies.get(rid)
        if (!mp) {
          mp = new Mesh({ geometry: src.mesh.geometry, texture: src.mesh.texture })
          sp.maskProxies.set(rid, mp)
          sp.maskContainer.addChild(mp)
        }
        const m = new Matrix(...part.matrix)
        m.tx -= rx0
        m.ty -= ry0
        mp.setFromMatrix(m)
        mp.visible = true
        mp.alpha = Math.min(1, src.opacity * (part.opacity ?? 1))
      }
      app.renderer.render({ container: sp.maskContainer, target: sp.maskTarget, clear: true })

      sp.casterContainer.filterArea = new Rectangle(0, 0, rw, rh)
      if (blur > 0) {
        if (!sp.blurFilter) sp.blurFilter = new BlurFilter({ strength: blur, quality: 2 })
        else sp.blurFilter.strength = blur
        sp.casterContainer.filters = [sp.silhouetteFilter, sp.blurFilter]
      } else {
        sp.casterContainer.filters = [sp.silhouetteFilter]
      }
      app.renderer.render({ container: sp.clipRoot, target: sp.target, clear: true })

      sp.sprite.position.set(rx0, ry0)
      sp.sprite.zIndex =
        maxReceiverIdx < minCasterIdx
          ? maxReceiverIdx + 0.08 + si * 1e-4
          : Math.max(0, minCasterIdx - 0.05) + si * 1e-4
      sp.sprite.tint = sh.color ?? 0x6b5870
      sp.sprite.alpha = shadowOpacity
      sp.sprite.blendMode = sh.blendMode ?? 'multiply'
      sp.sprite.visible = true
    }
    for (let si = shadows.length; si < shadowPasses.length; si++) {
      shadowPasses[si]!.sprite.visible = false
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
