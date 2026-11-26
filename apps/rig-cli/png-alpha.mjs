import { readFile, writeFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function channelsForColorType(colorType) {
  switch (colorType) {
    case 0:
      return 1
    case 2:
      return 3
    case 3:
      return 1
    case 4:
      return 2
    case 6:
      return 4
    default:
      throw new Error(`不支持的 PNG colorType=${colorType}`)
  }
}

/** Decode PNG bytes (non-interlaced) and return 8-bit alpha channel buffer. */
export function decodePngAlpha(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 33) throw new Error('无效 PNG：文件过短')
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('无效 PNG：文件头签名不匹配')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let trns = null
  const idatChunks = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) throw new Error(`PNG 块 ${type} 越界`)

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart)
      height = buf.readUInt32BE(dataStart + 4)
      bitDepth = buf[dataStart + 8]
      colorType = buf[dataStart + 9]
      const compression = buf[dataStart + 10]
      const filter = buf[dataStart + 11]
      interlace = buf[dataStart + 12]
      if (compression !== 0 || filter !== 0) throw new Error('不支持非标准 PNG 压缩或过滤方式')
      if (interlace !== 0) throw new Error('暂不支持隔行交错 (Adam7) PNG')
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  if (!width || !height) throw new Error('PNG 缺少有效 IHDR 尺寸')
  const channels = channelsForColorType(colorType)
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`不支持的 PNG 位深：${bitDepth}`)
  if (colorType !== 3 && bitDepth < 8 && colorType !== 0) {
    throw new Error(`不支持的 PNG colorType=${colorType} bitDepth=${bitDepth}`)
  }

  const raw = inflateSync(Buffer.concat(idatChunks))
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  if (raw.length < height * (stride + 1)) {
    throw new Error('PNG 解压数据不完整')
  }

  const prev = new Uint8Array(stride)
  const curr = new Uint8Array(stride)
  const alpha = new Uint8Array(width * height)

  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1
  const trnsRgb =
    colorType === 2 && trns && trns.length >= 6
      ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : null

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1)
    const filterType = raw[rowOffset]
    for (let i = 0; i < stride; i++) {
      const x = raw[rowOffset + 1 + i]
      const a = i >= bpp ? curr[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      switch (filterType) {
        case 0:
          curr[i] = x
          break
        case 1:
          curr[i] = (x + a) & 0xff
          break
        case 2:
          curr[i] = (x + b) & 0xff
          break
        case 3:
          curr[i] = (x + ((a + b) >> 1)) & 0xff
          break
        case 4:
          curr[i] = (x + paeth(a, b, c)) & 0xff
          break
        default:
          throw new Error(`未知 PNG 扫描线过滤类型：${filterType}`)
      }
    }

    const rowOut = y * width
    if (colorType === 6) {
      if (bitDepth === 8) {
        for (let x = 0; x < width; x++) alpha[rowOut + x] = curr[x * 4 + 3]
      } else {
        for (let x = 0; x < width; x++) alpha[rowOut + x] = curr[x * 8 + 6]
      }
    } else if (colorType === 4) {
      if (bitDepth === 8) {
        for (let x = 0; x < width; x++) alpha[rowOut + x] = curr[x * 2 + 1]
      } else {
        for (let x = 0; x < width; x++) alpha[rowOut + x] = curr[x * 4 + 2]
      }
    } else if (colorType === 3) {
      if (bitDepth === 8) {
        for (let x = 0; x < width; x++) {
          const idx = curr[x]
          alpha[rowOut + x] = trns && idx < trns.length ? trns[idx] : 255
        }
      } else {
        const mask = (1 << bitDepth) - 1
        const perByte = 8 / bitDepth
        for (let x = 0; x < width; x++) {
          const byte = curr[(x / perByte) | 0]
          const shift = 8 - bitDepth * ((x % perByte) + 1)
          const idx = (byte >> shift) & mask
          alpha[rowOut + x] = trns && idx < trns.length ? trns[idx] : 255
        }
      }
    } else if (colorType === 2) {
      if (!trnsRgb) {
        alpha.fill(255, rowOut, rowOut + width)
      } else if (bitDepth === 8) {
        for (let x = 0; x < width; x++) {
          const i = x * 3
          alpha[rowOut + x] =
            curr[i] === trnsRgb[0] && curr[i + 1] === trnsRgb[1] && curr[i + 2] === trnsRgb[2] ? 0 : 255
        }
      } else {
        for (let x = 0; x < width; x++) {
          const i = x * 6
          const r = (curr[i] << 8) | curr[i + 1]
          const g = (curr[i + 2] << 8) | curr[i + 3]
          const b = (curr[i + 4] << 8) | curr[i + 5]
          alpha[rowOut + x] = r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255
        }
      }
    } else if (colorType === 0) {
      if (trnsGray < 0) {
        alpha.fill(255, rowOut, rowOut + width)
      } else if (bitDepth === 8) {
        for (let x = 0; x < width; x++) alpha[rowOut + x] = curr[x] === trnsGray ? 0 : 255
      } else if (bitDepth === 16) {
        for (let x = 0; x < width; x++) {
          const v = (curr[x * 2] << 8) | curr[x * 2 + 1]
          alpha[rowOut + x] = v === trnsGray ? 0 : 255
        }
      } else {
        alpha.fill(255, rowOut, rowOut + width)
      }
    }

    prev.set(curr)
  }

  return { width, height, alpha }
}

export async function readPngAlpha(filePath) {
  const bytes = await readFile(filePath)
  return decodePngAlpha(bytes)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Decode non-interlaced PNG bytes into straight 8-bit RGBA (`Uint8Array(width * height * 4)`). */
export function decodePngRgba(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 33) throw new Error('无效 PNG：文件过短')
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('无效 PNG：文件头签名不匹配')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let plte = null
  let trns = null
  const idatChunks = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) throw new Error(`PNG 块 ${type} 越界`)
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart)
      height = buf.readUInt32BE(dataStart + 4)
      bitDepth = buf[dataStart + 8]
      colorType = buf[dataStart + 9]
      if (buf[dataStart + 10] !== 0 || buf[dataStart + 11] !== 0) throw new Error('不支持非标准 PNG 压缩或过滤方式')
      interlace = buf[dataStart + 12]
      if (interlace !== 0) throw new Error('暂不支持隔行交错 (Adam7) PNG')
    } else if (type === 'PLTE') {
      plte = buf.subarray(dataStart, dataEnd)
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  if (!width || !height) throw new Error('PNG 缺少有效 IHDR 尺寸')
  const channels = channelsForColorType(colorType)
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`不支持的 PNG 位深：${bitDepth}`)

  const raw = inflateSync(Buffer.concat(idatChunks))
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  if (raw.length < height * (stride + 1)) throw new Error('PNG 解压数据不完整')

  const prev = new Uint8Array(stride)
  const curr = new Uint8Array(stride)
  const rgba = new Uint8Array(width * height * 4)

  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1
  const trnsRgb =
    colorType === 2 && trns && trns.length >= 6
      ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : null

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1)
    const filterType = raw[rowOffset]
    for (let i = 0; i < stride; i++) {
      const x = raw[rowOffset + 1 + i]
      const a = i >= bpp ? curr[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      switch (filterType) {
        case 0: curr[i] = x; break
        case 1: curr[i] = (x + a) & 0xff; break
        case 2: curr[i] = (x + b) & 0xff; break
        case 3: curr[i] = (x + ((a + b) >> 1)) & 0xff; break
        case 4: curr[i] = (x + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`未知 PNG 扫描线过滤类型：${filterType}`)
      }
    }
    const rowOut = y * width * 4
    if (colorType === 6) {
      if (bitDepth === 8) {
        rgba.set(curr.subarray(0, width * 4), rowOut)
      } else {
        for (let x = 0; x < width; x++) {
          const s = x * 8
          const d = rowOut + x * 4
          rgba[d] = curr[s]
          rgba[d + 1] = curr[s + 2]
          rgba[d + 2] = curr[s + 4]
          rgba[d + 3] = curr[s + 6]
        }
      }
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const d = rowOut + x * 4
        if (bitDepth === 8) {
          const s = x * 3
          const r = curr[s], g = curr[s + 1], b = curr[s + 2]
          rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b
          rgba[d + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255
        } else {
          const s = x * 6
          const r16 = (curr[s] << 8) | curr[s + 1]
          const g16 = (curr[s + 2] << 8) | curr[s + 3]
          const b16 = (curr[s + 4] << 8) | curr[s + 5]
          rgba[d] = curr[s]; rgba[d + 1] = curr[s + 2]; rgba[d + 2] = curr[s + 4]
          rgba[d + 3] = trnsRgb && r16 === trnsRgb[0] && g16 === trnsRgb[1] && b16 === trnsRgb[2] ? 0 : 255
        }
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const d = rowOut + x * 4
        const g = bitDepth === 8 ? curr[x * 2] : curr[x * 4]
        const a = bitDepth === 8 ? curr[x * 2 + 1] : curr[x * 4 + 2]
        rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = a
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const d = rowOut + x * 4
        if (bitDepth === 8) {
          const g = curr[x]
          rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g
          rgba[d + 3] = trnsGray >= 0 && g === trnsGray ? 0 : 255
        } else if (bitDepth === 16) {
          const g16 = (curr[x * 2] << 8) | curr[x * 2 + 1]
          const g = curr[x * 2]
          rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g
          rgba[d + 3] = trnsGray >= 0 && g16 === trnsGray ? 0 : 255
        } else {
          const mask = (1 << bitDepth) - 1
          const perByte = 8 / bitDepth
          const rawVal = (curr[(x / perByte) | 0] >> (8 - bitDepth * ((x % perByte) + 1))) & mask
          const g = Math.round((rawVal / mask) * 255)
          rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g
          rgba[d + 3] = trnsGray >= 0 && rawVal === trnsGray ? 0 : 255
        }
      }
    } else if (colorType === 3) {
      if (!plte) throw new Error('索引 PNG 缺少 PLTE 调色板')
      const mask = (1 << bitDepth) - 1
      const perByte = 8 / bitDepth
      for (let x = 0; x < width; x++) {
        const idx =
          bitDepth === 8
            ? curr[x]
            : (curr[(x / perByte) | 0] >> (8 - bitDepth * ((x % perByte) + 1))) & mask
        const d = rowOut + x * 4
        rgba[d] = plte[idx * 3] ?? 0
        rgba[d + 1] = plte[idx * 3 + 1] ?? 0
        rgba[d + 2] = plte[idx * 3 + 2] ?? 0
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255
      }
    }
    prev.set(curr)
  }
  return { width, height, rgba }
}

/** Encode straight 8-bit RGBA (`Uint8Array(width * height * 4)`) to standard PNG bytes. */
export function encodePngRgba(width, height, rgba) {
  if (!(width > 0 && height > 0) || rgba.length !== width * height * 4) {
    throw new Error('encodePngRgba 尺寸或像素缓冲区不匹配')
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bitDepth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowBytes = width * 4
  const raw = Buffer.allocUnsafe(height * (rowBytes + 1))
  for (let y = 0; y < height; y++) {
    const outStart = y * (rowBytes + 1)
    raw[outStart] = 0 // filter: None
    const srcStart = y * rowBytes
    raw.set(rgba.subarray(srcStart, srcStart + rowBytes), outStart + 1)
  }
  const idat = deflateSync(raw, { level: 6 })
  return Buffer.concat([
    Buffer.from(PNG_SIG),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export async function readPngRgba(filePath) {
  return decodePngRgba(await readFile(filePath))
}

export async function writePngRgba(filePath, width, height, rgba) {
  await writeFile(filePath, encodePngRgba(width, height, rgba))
}
