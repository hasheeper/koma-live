"""Offline PMA pixel proof for exported slices and rig-core pose samples."""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def image_pixels(path, size, linear):
    with Image.open(path) as image:
        if image.format != "PNG" or image.size != tuple(size):
            raise ValueError(f"PNG 格式或尺寸不符 {path}")
        pixels = np.asarray(image.convert("RGBA"), dtype=np.float64) / 255
    rgb = pixels[..., :3]
    if linear:
        rgb[:] = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    rgb *= pixels[..., 3:]
    return pixels


def sample(texture, u, v):
    height, width = texture.shape[:2]
    x = np.clip(u * width - .5, 0, width - 1)
    y = np.clip(v * height - .5, 0, height - 1)
    x0, y0 = x.astype(int), y.astype(int)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return ((1-fy) * ((1-fx)*texture[y0,x0] + fx*texture[y0,x1])
            + fy * ((1-fx)*texture[y1,x0] + fx*texture[y1,x1]))


def paint(surface, texture, coverage, layer, part):
    x, y, w, h = layer["rect"]
    opacity = layer["opacity"] * part.get("opacity", 1)
    placement = part.get("matrix", [1, 0, 0, 1, x, y])
    if (not part.get("geometry") and not part.get("mask") and placement[:4] == [1, 0, 0, 1]
            and float(placement[4]).is_integer() and float(placement[5]).is_integer()):
        x, y = map(int, placement[4:])
        left, top = max(0, x), max(0, y)
        right, bottom = min(surface.shape[1], x+w), min(surface.shape[0], y+h)
        if right > left and bottom > top:
            crop = np.s_[top-y:bottom-y, left-x:right-x]
            src = texture[crop] * opacity
            k = src[..., 3:] if coverage is None else coverage[crop][..., 3:]
            dest = surface[top:bottom, left:right]
            dest[:] = src + (1-k)*dest
        return
    matrix = np.array(placement).reshape(3, 2)
    geo = part.get("geometry", {})
    points = np.array(geo.get("vertices", [0,0,w,0,0,h,w,h])).reshape(-1,2) @ matrix[:2] + matrix[2]
    uv = np.array(geo.get("uv", [0,0,1,0,0,1,1,1])).reshape(-1,2)
    indices = np.array(geo.get("indices", [0,1,2,1,3,2])).reshape(-1,3)
    # One sample per destination pixel, including shared triangle edges.
    lo = np.maximum(0, np.floor(points.min(axis=0)).astype(int))
    hi = np.minimum(surface.shape[1::-1], np.ceil(points.max(axis=0)).astype(int))
    if np.any(hi <= lo):
        return
    written = np.zeros((hi[1]-lo[1], hi[0]-lo[0]), dtype=bool)
    for tri in indices:
        a, b, c = points[tri]
        u, v = b-a, c-a
        det = u[0]*v[1] - u[1]*v[0]
        if abs(det) < 1e-14:
            raise ValueError(f'{layer["layerId"]} 退化三角形')
        left, top = np.maximum(lo, np.floor(points[tri].min(axis=0)).astype(int))
        right, bottom = np.minimum(hi, np.ceil(points[tri].max(axis=0)).astype(int))
        if right <= left or bottom <= top:
            continue
        yy, xx = np.mgrid[top:bottom, left:right]
        dx, dy = xx + .5-a[0], yy + .5-a[1]
        s, t = (dx*v[1]-dy*v[0])/det, (dy*u[0]-dx*u[1])/det
        keep = (s >= -1e-10) & (t >= -1e-10) & (s+t <= 1+1e-10) & ~written[yy-lo[1],xx-lo[0]]
        if part.get("mask"):
            polygon = part["mask"]
            inside = np.zeros_like(keep)
            for i, (px,py) in enumerate(polygon):
                qx, qy = polygon[i-1]
                if qy != py:
                    inside ^= ((py > yy+.5) != (qy > yy+.5)) & (xx+.5 < (qx-px)*(yy+.5-py)/(qy-py)+px)
            keep &= inside
        xx,yy = xx[keep],yy[keep]
        written[yy-lo[1],xx-lo[0]] = True
        ta,tb,tc = uv[tri]
        coords = ta + s[keep,None]*(tb-ta) + t[keep,None]*(tc-ta)
        src = sample(texture, *coords.T) * opacity
        k = src[:, 3:] if coverage is None else sample(coverage, *coords.T)[:, 3:]
        surface[yy,xx] = src + (1-k)*surface[yy,xx]


def compose_package(root, manifest, pose=None):
    width, height = (manifest["canvas"][k] for k in ("width","height"))
    linear = manifest["format"] == "koma-rig.slices.v1"
    canvas = np.zeros((height,width,4), dtype=np.float64)
    layers = {l["layerId"]:l for l in manifest["layers"]}
    memberships = {m["layerId"]:(g,m) for g in manifest.get("gelGroups",[]) for m in g["members"]}
    group_surface = None
    for part in (pose["parts"] if pose is not None else [{"layerId":i} for i in layers]):
        layer_id = part["layerId"]
        layer = layers[layer_id]
        group, member = memberships.get(layer_id, (None,None))
        if group and member is group["members"][0]:
            group_surface = np.zeros_like(canvas)
        size = layer["rect"][2:]
        texture = image_pixels(root/layer["texture"], size, linear)
        coverage = image_pixels(root/member["coverage"], size, False) if member else None
        if coverage is not None and np.any(texture[...,3]*layer["opacity"] > coverage[...,3]+1/255+1e-12):
            raise ValueError(f"{layer_id} 画色超出覆盖轮廓")
        if part.get("visible",layer["visible"]):
            paint(group_surface if group else canvas, texture, coverage, layer, part)
        if group and member is group["members"][-1]:
            src = group_surface * group["opacity"]
            canvas = src + (1-src[...,3:])*canvas
            group_surface = None
    if linear:
        alpha = canvas[...,3:]
        rgb = np.divide(canvas[...,:3],alpha,out=np.zeros_like(canvas[...,:3]),where=alpha>0)
        canvas[...,:3] = np.where(rgb <= .0031308, 12.92*rgb, 1.055*np.maximum(rgb,0)**(1/2.4)-.055)*alpha
    return np.clip(canvas,0,1)


def compare(root, manifest, actual, tolerance, heatmap=None):
    if not 0 <= tolerance <= 255:
        raise ValueError("像素容差须在 0–255 之间")
    reference = image_pixels(root / manifest["reference"], actual.shape[1::-1], False)
    error = np.abs(np.rint(actual*255) - np.rint(reference*255)).max(axis=2)
    mask = error > tolerance
    y,x = np.where(mask)
    if heatmap:
        heat = np.zeros((*mask.shape,4),dtype=np.uint8)
        if mask.any():
            heat[mask] = [255,32,0,255]
            heat[...,1][mask] = np.rint(220 - 188 * error[mask] / error.max()).astype(np.uint8)
        Image.fromarray(heat).save(heatmap)
    return dict(tolerance=tolerance, mismatches=int(mask.sum()), maxError=int(error.max()),
                bounds=[int(x.min()),int(y.min()),int(x.max()+1),int(y.max()+1)] if len(x) else None)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("root",type=Path)
    p.add_argument("--pose",type=Path)
    p.add_argument("--output",type=Path)
    p.add_argument("--heatmap",type=Path)
    p.add_argument("--tolerance",type=int,default=1)
    args = p.parse_args()
    manifest = json.loads((args.root/"manifest.json").read_text())
    assets = [manifest["reference"], *(l["texture"] for l in manifest["layers"]),
              *(m["coverage"] for g in manifest.get("gelGroups", []) for m in g["members"])]
    for path in (args.output, args.heatmap):
        if path and path.resolve() in {(args.root / f).resolve() for f in assets}:
            p.error("输出文件与源素材重名")
    pose = json.loads(args.pose.read_text()) if args.pose else None
    actual = compose_package(args.root,manifest,pose)
    if args.output:
        alpha = actual[...,3:]
        actual[...,:3] = np.divide(actual[...,:3],alpha,out=np.zeros_like(actual[...,:3]),where=alpha>0)
        Image.fromarray(np.rint(actual*255).astype(np.uint8)).save(args.output)
    else:
        report = compare(args.root,manifest,actual,args.tolerance,args.heatmap)
        print(json.dumps(report))
        if report["mismatches"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
