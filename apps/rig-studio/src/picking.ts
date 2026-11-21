import { inverse, transform, type Geometry, type Part, type Point } from '@koma-rig/rig-core'

function insideMask([x,y]: Point, polygon: Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a,b] = polygon[i]!, [c,d] = polygon[j]!
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside
  }
  return inside
}

/** Interpolate texture coordinates on the same triangles that Pixi draws. */
function texturePixel(g: Geometry, point: Point, width: number, height: number): Point | undefined {
  const { vertices, indices, uv } = g
  for (let i = 0; i < indices.length; i += 3) {
    const a = 2 * indices[i]!, b = 2 * indices[i+1]!, c = 2 * indices[i+2]!
    const bx = vertices[b]! - vertices[a]!, by = vertices[b+1]! - vertices[a+1]!
    const cx = vertices[c]! - vertices[a]!, cy = vertices[c+1]! - vertices[a+1]!
    const dx = point[0] - vertices[a]!, dy = point[1] - vertices[a+1]!
    const area = bx * cy - by * cx
    if (!area) continue
    const s = (dx * cy - dy * cx) / area, t = (bx * dy - by * dx) / area
    if (s < 0 || t < 0 || s + t > 1) continue
    const u = uv[a]! * (1-s-t) + uv[b]! * s + uv[c]! * t
    const v = uv[a+1]! * (1-s-t) + uv[b+1]! * s + uv[c+1]! * t
    return [Math.max(0, Math.min(width-1, Math.floor(u*width))), Math.max(0, Math.min(height-1, Math.floor(v*height)))]
  }
}

export function hitPart(part: Part, point: Point, width: number, height: number, alpha: Uint8Array | undefined): boolean {
  if (!part.visible || part.opacity === 0 || !alpha || (part.mask && !insideMask(point, part.mask))) return false
  const local = transform(inverse(part.matrix), ...point)
  const pixel = part.geometry ? texturePixel(part.geometry, local, width, height) : local
  if (!pixel) return false
  const [x, y] = pixel.map(Math.floor) as Point
  return x >= 0 && x < width && y >= 0 && y < height && alpha[y * width + x]! > 0
}
