import type { SliceManifest } from '@koma-rig/rig-core'

/** Verify the native-size rest stack in sRGB premultiplied RGBA. */
async function inspect({manifest: m, files, verify}: {manifest: SliceManifest; files: Map<string, Blob>; verify: boolean}) {
  const {width, height} = m.canvas
  const canvas = verify ? new Float32Array(width * height * 4) : null
  const alpha = new Map<string, Uint8Array>()
  const coverageAlpha = new Map<string, Uint8Array>()
  // Canvas2D round-trips through an 8-bit premultiplied backing store. Read
  // straight RGBA directly before multiplying, just as the offline proof does.
  const readback = verify ? new OffscreenCanvas(1, 1) : null
  const gl = readback?.getContext('webgl2') ?? readback?.getContext('webgl')
  if (verify && !gl) throw new Error('浏览器无法在后台读取原始切片像素。')
  if (gl) {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer())
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  }
  async function pixels(path: string, w: number, h: number) {
    const file = files.get(path)
    if (!file) throw new Error('缺少 ' + path)
    const image = await createImageBitmap(file, {colorSpaceConversion:'none', premultiplyAlpha:'none'})
    try {
      if (image.width !== w || image.height !== h) throw new Error('切片尺寸不符：' + path)
      if (gl) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('无法按原始尺寸读取 ' + path)
        }
        const data = new Uint8Array(w * h * 4)
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data)
        if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw new Error('读取纹理失败：' + path)
        return data
      }
      const ctx = new OffscreenCanvas(w,h).getContext('2d', {willReadFrequently:true})
      if (!ctx) throw new Error('浏览器无法读取切片像素。')
      ctx.drawImage(image,0,0)
      return ctx.getImageData(0,0,w,h).data
    } finally { image.close() }
  }
  const groups = m.format === 'koma-rig.slices.v2' ? m.gelGroups ?? [] : []
  const members = new Map(groups.flatMap(g => g.members.map(member => [member.layerId,{g,member}] as const)))
  let group: Float32Array | null = null
  for (const layer of m.layers) {
    const [x,y,w,h] = layer.rect, data = await pixels(layer.texture,w,h)
    const mask = new Uint8Array(w*h)
    const membership = members.get(layer.layerId)
    const coverage = membership ? await pixels(membership.member.coverage,w,h) : null
    if (canvas && membership && membership.g.members[0] === membership.member) group = new Float32Array(canvas.length)
    const target = group ?? canvas
    for (let i=0; i<mask.length; i++) {
      const off=i*4, a=data[off+3]!/255*layer.opacity
      mask[i]=data[off+3]!
      const k=coverage ? coverage[off+3]!/255 : a
      if (coverage && a>k+1/255+1e-10) throw new Error(layer.name+' 超出覆盖轮廓')
      if (!target || !layer.visible) continue
      const px=x+i%w, py=y+Math.floor(i/w)
      if (px<0 || py<0 || px>=width || py>=height) continue
      const j=(py*width+px)*4
      for (let c=0;c<4;c++) target[j+c]=(c===3?1:data[off+c]!/255)*a+(1-k)*target[j+c]!
    }
    alpha.set(layer.layerId,mask)
    if (coverage) coverageAlpha.set(layer.layerId, mask.map((a,i) => Math.max(a,coverage[i*4+3]!)))
    if (canvas && group && membership && membership.g.members.at(-1) === membership.member) {
      const opacity=membership.g.opacity
      for (let i=0;i<canvas.length;i+=4) {
        const keep=1-group[i+3]!*opacity
        for (let c=0;c<4;c++) canvas[i+c]=group[i+c]!*opacity+canvas[i+c]!*keep
      }
      group=null
    }
  }
  if (canvas) {
    const ref=await pixels(m.reference,width,height)
    let bad=0, max=0
    for(let i=0;i<ref.length;i+=4){
      let delta=0
      for(let c=0;c<4;c++){
        const expected=c===3?ref[i+3]!:Math.round(ref[i+c]!*ref[i+3]!/255)
        delta=Math.max(delta,Math.abs(Math.round(Math.min(1,canvas[i+c]!)*255)-expected))
      }
      if(delta>1){bad++;max=Math.max(max,delta)}
    }
    if(bad)throw new Error('与 reference.png 比对有 '+bad+' 个像素超差，最大偏差 '+max+'。')
  }
  return {alpha, coverageAlpha}
}
self.onmessage=async ({data}: MessageEvent<Parameters<typeof inspect>[0]>)=>{
  try { self.postMessage(await inspect(data)) }
  catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)})}
}
