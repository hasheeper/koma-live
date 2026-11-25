"""Bake one character's head samples into validated Koma Morph edit operations."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from fetch_tha3 import CACHE, SOURCE
from teacher import collect_samples
from warp import (
    controls,
    couple_hair_parallax,
    dampen_eye_roll_on_pitch,
    fit_field,
    forward,
    horizontal_curvature,
    jacobians,
    lattice_points,
    pin_lattice,
    register_features,
    symmetrize_pitch_field,
    symmetrize_yaw_pair,
)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/psd/src"))
from layer_rig_psd.proof import compose_package

POSES = [(x, y) for y in (-1, 0, 1) for x in (-1, 0, 1)]


def read(path):
    return json.loads(path.read_bytes())


def framing(cfg, layers):
    if "faceBox" in cfg:
        x, y, w, h = cfg["faceBox"]
    else:
        rects = np.asarray([layers[k]["rect"] for k in cfg.get("headLayers", [cfg["faceLayer"]])])
        x, y = rects[:, :2].min(axis=0)
        w, h = (rects[:, :2] + rects[:, 2:]).max(axis=0) - [x, y]
    side = round(max(w, h) * 4)
    top = y + h / 2 - side / 4
    if "eyeTargetYRatio" in cfg:
        eyes = np.asarray([layers[k]["rect"] for k in cfg["eyeAnchorLayers"]])
        side = round(h * cfg.get("scaleFactor", 2.85))
        top = np.mean(eyes[:, 1] + eyes[:, 3]/2) - side * cfg["eyeTargetYRatio"]
    if side <= 0:
        raise ValueError("Empty head framing")
    return round(x + w / 2 - side / 2), round(top), side


def context_image(root, manifest, ordered, ids, crop):
    ids = set(ids)
    selected = [layer for layer in ordered if layer["layerId"] in ids]
    groups = []
    for group in manifest.get("gelGroups", []):
        members = [m for m in group["members"] if m["layerId"] in ids]
        if members:
            groups.append({**group, "members": members})
    pma = compose_package(root, {**manifest, "layers": selected, "gelGroups": groups},
                          {"parts": [{"layerId": l["layerId"], "visible": True} for l in selected]})
    alpha = pma[..., 3:]
    np.divide(pma[..., :3], alpha, out=pma[..., :3], where=alpha > 0)
    image = Image.fromarray(np.rint(pma * 255).astype("uint8"))
    x, y, s = crop
    return image.crop((x, y, x+s, y+s)).resize((512, 512), Image.Resampling.LANCZOS)


def board(rows, output, side=220):
    sheet = Image.new("RGB", (max(map(len, rows))*side, len(rows)*(side+22)), "#bab8c2")
    draw = ImageDraw.Draw(sheet)
    for j, row in enumerate(rows):
        for i, (caption, image) in enumerate(row):
            x, y = i*side, j*(side+22)
            tile = image.convert("RGBA").resize((side, side), Image.Resampling.LANCZOS)
            sheet.paste(tile, (x, y+22), tile)
            draw.text((x+5, y+4), caption, fill="#171421")
    sheet.save(output)


def targets(cfg):
    result = {}
    shared = cfg["targets"]["sharedFaceGroup"]
    for layer, grid in shared["layers"].items():
        result[layer] = (shared["pass"], cfg["framing"]["faceLayer"], grid or shared["gridDefault"], None, None)
    for layer, info in cfg["targets"]["independentLayers"].items():
        if layer in result:
            raise ValueError(f"Duplicate bake target {layer}")
        result[layer] = (
            info["pass"],
            info.get("fitLayer", layer),
            info["grid"],
            info.get("followPoint"),
            info.get("parallaxScale"),
        )
    return result


def field_preview(image, crop, points, deltas, face):
    """Show each face cell's minimum corner determinant on the displaced mesh."""
    layer = Image.new("RGBA", image.size)
    ink = ImageDraw.Draw(layer)
    rest = points[face]
    offset = deltas.get(face, np.zeros_like(rest))
    cells = jacobians(rest, offset).min(axis=0)
    def screen(p):
        return tuple((p - crop[:2]) * 512 / crop[2])
    for j, i in np.ndindex(cells.shape):
        ratio = cells[j, i]
        color = (211, 90, 34, 110) if ratio < .8 else (22, 136, 142, 85) if ratio <= 1.2 else (70, 84, 198, 100)
        polygon = [screen(rest[y,x]+offset[y,x]) for y,x in ((j,i),(j,i+1),(j+1,i+1),(j+1,i))]
        ink.polygon(polygon, fill=color, outline=(32,46,54,100))
    for pt, off in zip(rest.reshape(-1,2), offset.reshape(-1,2)):
        ink.line([screen(pt), screen(pt+off)], fill=(20,42,55,255), width=1)
    preview = Image.alpha_composite(image, layer)
    lo, hi = np.array(screen(rest[0,0])), np.array(screen(rest[-1,-1]))
    half = max(hi-lo)*.78
    center = (lo+hi)/2
    return preview.crop(tuple(np.rint(np.r_[center-half, center+half]).astype(int)))


def bake(args):
    root = args.work.resolve()
    if (root / "koma-work.json").exists():
        root = (root / read(root / "koma-work.json")["rig"]).resolve()
    config = args.config or args.work / "head-bake.json"
    if args.config is None and not config.exists():
        config = root.parent / "head-bake.json"
    manifest_bytes = (root/"manifest.json").read_bytes()
    cfg, manifest = read(config), json.loads(manifest_bytes)
    rig_bytes = (root/"rig.json").read_bytes()
    rig = json.loads(rig_bytes)
    if cfg["format"] != "koma-rig.head-bake.v1" or cfg["backend"] != "tha3" or cfg["model"] != "separable_float":
        raise ValueError("Expected koma-rig.head-bake.v1 and THA3 separable_float")
    if manifest.get("textureScale", 1) != 1:
        raise ValueError("Use the full-resolution source slices for baking")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    layers = {l["layerId"]: l for l in manifest["layers"]}
    ordered = [layers[k] for k in rig.get("drawOrder", layers)]
    groups = targets(cfg)
    shared = cfg["targets"]["sharedFaceGroup"]
    curvature_scale = float(shared.get("yawCurvatureScale", 1))
    if not np.isfinite(curvature_scale) or curvature_scale < 0:
        raise ValueError("yawCurvatureScale must be finite and non-negative")
    pitch_curvature_scale = float(shared.get("pitchCurvatureScale", 1))
    if not np.isfinite(pitch_curvature_scale) or pitch_curvature_scale < 0:
        raise ValueError("pitchCurvatureScale must be finite and non-negative")
    symmetrize_pitch = bool(shared.get("symmetrizePitch", False))
    symmetrize_yaw = bool(shared.get("symmetrizeYaw", False))
    yaw_near_scale = float(shared.get("yawHorizontalScale", 1))
    if not np.isfinite(yaw_near_scale) or yaw_near_scale <= 0:
        raise ValueError("yawHorizontalScale must be finite and positive")
    face = cfg["passes"]["faceContextLayers"]
    passes = {"face": face, "hair": face + cfg["passes"]["hairContextAddLayers"]}
    for name in [*groups, *passes["hair"]]:
        if name not in layers:
            raise ValueError(f"Unknown layer {name}")
    crop = framing(cfg["framing"], layers)
    contexts = {p: context_image(root, manifest, ordered, ids, crop) for p, ids in passes.items()}
    framed = []
    for p, im in contexts.items():
        im.save(out / f"input-{p}.png")
        guide = im.copy()
        ImageDraw.Draw(guide).rectangle((192, 64, 320, 192), outline="#008080", width=2)
        framed.append((p, guide))
    board([framed], out / "framing_preview.png", 384)
    yaw, pitch = (cfg["parameters"][key] for key in ("yaw", "pitch"))
    if yaw["id"] == pitch["id"]:
        raise ValueError("Yaw and pitch must reference different parameters")
    if any(not 0 < amp <= 1 for amp in (yaw["tha3Amplitude"], pitch["tha3Up"], pitch["tha3Down"])):
        raise ValueError("THA3 axis amplitudes must be in (0, 1]")
    if any(axis.get("sign", 1) not in (-1, 1) for axis in (yaw, pitch)):
        raise ValueError("Axis sign must be -1 or 1")
    poses = [(x*yaw["tha3Amplitude"]*yaw.get("sign", 1),
              y*(pitch["tha3Up"] if y < 0 else pitch["tha3Down"])*pitch.get("sign", 1)) for x,y in POSES]
    samples = collect_samples(args.weights_dir.resolve(), args.device, contexts, poses, out/".inference")
    for p, sequence in samples.items():
        print(f"{p}: 9 samples ({sequence[0]['device']})", flush=True)
    for key, filename in (("raw","tha3_raw_9grid"), ("coarse_warp","rotator_warp"), ("fine_warp","editor_warp")):
        rows = [[(f"{p}  yaw {x:+}  pitch {y:+}", Image.fromarray(samples[p][k][key]))
                 for p in contexts for k,(x,y) in enumerate(POSES) if y == row] for row in (-1,0,1)]
        board(rows, out/(filename+".png"))
    axes = [{"parameter": a["id"], "samples": [-1,0,1]} for a in (yaw,pitch)]
    morphs = {k: {"layerId": k, "grid": grid, "axes": axes, "deltas": [None]*9}
              for k, (_,_,grid,_,_) in groups.items()}
    points = {k: lattice_points(layers[k]["rect"], grid) for k, (_,_,grid,_,_) in groups.items()}
    face_id = cfg["framing"]["faceLayer"]
    face_key = shared["pass"], face_id
    if face_id not in points:
        points[face_id] = lattice_points(layers[face_id]["rect"], shared["gridDefault"])
    fits = {}
    fit_keys = dict.fromkeys([(p, layer) for p, layer, _, _, _ in groups.values()] + [face_key])
    for channel, layer in fit_keys:
        with Image.open(root/layers[layer]["texture"]) as tex:
            fits[channel,layer] = controls(layers[layer], np.asarray(tex.convert("RGBA"))[...,3])
    fx, fy, fw, fh = layers[cfg["framing"]["faceLayer"]]["rect"]
    face_cx = float(cfg["framing"].get("faceCenterX", fx + fw / 2))
    anchor = np.asarray(cfg["framing"].get("neckAnchor", [fx+fw/2, fy+fh]), dtype=float)
    anchors = anchor + np.array([[0,0],[-3,0],[3,0],[0,3],[0,-3]])

    # Stage 1: Fit all 8 non-neutral pose fields first so opposite yaw pairs can be mirror-symmetrized cleanly
    pose_fields = {}
    pose_original_face = {}
    pose_residuals = {}
    pose_alphas = {}
    for index, (x, y) in enumerate(POSES):
        if index == 4:
            continue
        fields, residuals, alphas = {}, [], {}
        original_face = None
        for channel in contexts:
            neutral = samples[channel][4][args.field]
            target = samples[channel][index][args.field]
            shift, anchor_err = forward(anchors, neutral, target, crop)
            residuals.extend(anchor_err)
            for (p, layer), (coords, weights) in fits.items():
                if p != channel:
                    continue
                delta, err = forward(coords, neutral, target, crop)
                keep = err < .05
                if not keep.all():
                    raise ValueError(f"{channel}/{layer} inverse residual {err.max():.3f} px at {(x,y)}")
                residuals.extend(err)
                def fit(offsets):
                    field = fit_field(coords, offsets, weights, crop[2]/4, cfg.get("smoothing", .025))
                    if (p, layer) == face_key and shared.get("affineFeatures"):
                        field = register_features(field, shared["affineFeatures"])
                    return field
                offsets = delta - np.median(shift, axis=0)
                if (p, layer) == face_key:
                    original_face = fit(offsets)
                    if y and (pitch_curvature_scale != 1 or symmetrize_pitch):
                        yaw_only = samples[p][POSES.index((x, 0))][args.field]
                        yaw_delta, yaw_err = forward(coords, neutral, yaw_only, crop)
                        residuals.extend(yaw_err)
                        pitch_dy = delta[:, 1] - yaw_delta[:, 1]
                        if symmetrize_pitch:
                            pitch_dy_clean = dampen_eye_roll_on_pitch(coords, pitch_dy, weights)
                            offsets[:, 1] += pitch_dy_clean - pitch_dy
                            pitch_dy = pitch_dy_clean
                        if pitch_curvature_scale != 1:
                            offsets[:, 1] += (pitch_curvature_scale - 1) * horizontal_curvature(coords, pitch_dy, weights)
                    if x and (curvature_scale != 1 or yaw_near_scale != 1):
                        pitch_only = samples[p][POSES.index((0, y))][args.field]
                        pitch_delta, pitch_err = forward(coords, neutral, pitch_only, crop)
                        residuals.extend(pitch_err)
                        yaw_dx = delta[:, 0] - pitch_delta[:, 0]
                        if curvature_scale != 1:
                            offsets[:, 0] += (curvature_scale - 1) * horizontal_curvature(coords, yaw_dx, weights)
                        if yaw_near_scale != 1:
                            offsets[:, 0] += (yaw_near_scale - 1) * (coords[:, 0] - face_cx)
                    field_fn = fit(offsets)
                    if x == 0 and y != 0 and symmetrize_pitch:
                        field_fn = symmetrize_pitch_field(field_fn, face_cx)
                    fields[p, layer] = field_fn
                else:
                    fields[p, layer] = fit(offsets)
            alpha = samples[channel][index]["alpha"]
            visible = np.asarray(contexts[channel])[...,3] > 153
            alphas[channel] = round(float(alpha[visible].mean()), 4)
        if max(residuals) >= .05:
            raise ValueError(f"Neck anchor inversion failed at {(x,y)}")
        pose_fields[index] = fields
        pose_original_face[index] = original_face
        pose_residuals[index] = residuals
        pose_alphas[index] = alphas

    # Stage 1b: Optional mirror-symmetrization of opposite yaw poses (-1, y) <-> (+1, y) for clean L/R symmetry!
    if symmetrize_yaw:
        for y in (-1, 0, 1):
            i_neg = POSES.index((-1, y))
            i_pos = POSES.index((1, y))
            s_neg, s_pos = symmetrize_yaw_pair(pose_fields[i_neg][face_key], pose_fields[i_pos][face_key], face_cx)
            pose_fields[i_neg][face_key] = s_neg
            pose_fields[i_pos][face_key] = s_pos
            if pose_original_face[i_neg] is not None and pose_original_face[i_pos] is not None:
                o_neg, o_pos = symmetrize_yaw_pair(pose_original_face[i_neg], pose_original_face[i_pos], face_cx)
                pose_original_face[i_neg] = o_neg
                pose_original_face[i_pos] = o_pos

    # Stage 2: Sample lattices, couple hair parallax cleanly onto the face field, re-anchor & quantize
    measurements, drawings = [], []
    for index, (x, y) in enumerate(POSES):
        if index == 4:
            drawings.append(("neutral  J=1", field_preview(contexts["hair"], crop, points, {}, cfg["framing"]["faceLayer"])))
            continue
        fields = pose_fields[index]
        original_face = pose_original_face[index]
        residuals = pose_residuals[index]
        alphas = pose_alphas[index]
        deltas, fades, coupled_layers = {}, {}, set()
        for layer, (p, key, _, follow, parallax_scale) in groups.items():
            rest = points[layer]
            query = rest.reshape(-1, 2) if follow is None else np.tile(follow, (rest.size//2, 1))
            fn = fields[p, key]
            if parallax_scale is not None and original_face is not None:
                fn = couple_hair_parallax(fields[face_key], original_face, fn, parallax_scale)
                coupled_layers.add(layer)
            values = fn(query).reshape(rest.shape)
            # Beyond the teacher's crop, fade the strand end smoothly to its bone animation.
            uv = (rest - crop[:2]) / crop[2]
            outside = np.maximum(-uv, uv-1).max(axis=-1).clip(0, .15) / .15
            deltas[layer] = values
            fades[layer] = (1 - outside**2*(3-2*outside))[...,None]
        if face_id not in deltas:
            face_grid = points[face_id]
            deltas[face_id] = fields[face_key](face_grid.reshape(-1,2)).reshape(face_grid.shape)
            fades[face_id] = 1
        correction = pin_lattice(points[face_id], deltas[face_id], anchor)
        if correction is None:
            correction = np.zeros(2)
        else:
            for layer in cfg["targets"]["sharedFaceGroup"]["layers"]:
                if layer != face_id and np.array_equal(points[layer], points[face_id]):
                    deltas[layer] = deltas[face_id].copy()
        independent_correction = correction
        if original_face is not None:
            grid = points[face_id]
            base = original_face(grid.reshape(-1,2)).reshape(grid.shape)
            independent_correction = pin_lattice(grid, base, anchor)
            if independent_correction is None:
                independent_correction = np.zeros(2)
        deltas = {k: (d - (correction if (k in shared["layers"] or k == face_id or k in coupled_layers) else independent_correction)) * fades[k]
                  for k, d in deltas.items()}
        # Use a common damping factor so shared features keep the same motion.
        gain = 1.
        while True:
            # Centipixel rounding on independent slice grids can introduce visible
            # registration differences when a mask and its contents share an affine patch.
            quantized = {k: np.round(d * gain, 5 if shared.get("affineFeatures") and k in shared["layers"] else 2)
                         for k,d in deltas.items()}
            ratio = min(float(jacobians(points[k], d).min()) for k,d in quantized.items())
            if ratio > .15:
                break
            if not np.isfinite(ratio) or gain < .05:
                raise ValueError(f"No usable head field at {(x,y)}")
            gain *= .9
        for k,d in quantized.items():
            if k in morphs:
                morphs[k]["deltas"][index] = d.flatten().tolist()
        face_field = fields[face_key]
        probe = cfg["framing"].get("directionProbe", [fx+fw/2,fy+.72*fh])
        measurements.append(dict(yaw=x, pitch=y, gain=gain, minJacobian=ratio,
                                 maxInverseResidualPx=float(max(residuals)), colorChangeAlpha=alphas,
                                 latticeNeckCorrectionPx=correction.tolist(),
                                 faceProbeDelta=((face_field(np.array([probe]))[0]-correction)*gain).tolist()))
        shape = field_preview(contexts["hair"], crop, points, quantized, cfg["framing"]["faceLayer"])
        drawings.append((f"yaw {x:+} pitch {y:+}  all layers min J {ratio:.2f}", shape))
    board([drawings[i:i+3] for i in (0,3,6)], out/"warp_field_viz.png", 300)
    report = {"sourceRevision": SOURCE, "field": args.field, "crop": crop,
              "yawCurvatureScale": curvature_scale, "yawHorizontalScale": yaw_near_scale,
              "pitchCurvatureScale": pitch_curvature_scale, "symmetrizePitch": symmetrize_pitch,
              "devices": sorted({str(s["device"]) for seq in samples.values() for s in seq}),
              "targets": len(morphs), "poses": measurements}
    (out/"bake-report.json").write_text(json.dumps(report, indent=2, default=int)+"\n")
    by_pose = {(m["yaw"],m["pitch"]):m["faceProbeDelta"] for m in measurements}
    if not (by_pose[-1,0][0] < 0 < by_pose[1,0][0] and by_pose[0,-1][1] < 0 < by_pose[0,1][1]):
        raise ValueError("Head direction differs from screen right/down. Inspect bake-report.json and calibrate yaw/pitch sign.")
    # Keep independent parameters and Morphs on rebake, including other axes on the same layer.
    ids = [yaw["id"], pitch["id"]]
    existing = [m for m in rig.get("morphs", []) if not (
        m["layerId"] in groups and [a["parameter"] for a in m["axes"]] == ids)]
    ops = [{"op":"set-parameter", "parameter":{"id": k, "meaning": meaning, "unit":"normalized",
                                                "min":-1, "max":1, "default":0}}
           for k,meaning in zip(ids, ("左右转头（向右为正）","俯仰（向下为正）"))]
    ops.append({"op":"set-morphs", "morphs":existing + list(morphs.values())})
    operations = out/"edits.json"
    operations.write_text(json.dumps(ops, ensure_ascii=False, separators=(",",":"), allow_nan=False)+"\n")
    subprocess.run(["node", Path(__file__).with_name("validate.mjs"), root, operations, *ids,
                    hashlib.sha256(rig_bytes).hexdigest(), hashlib.sha256(manifest_bytes).hexdigest(),
                    json.dumps(list(groups)), json.dumps([cfg["framing"]["faceLayer"], anchor.tolist()]),
                    *(["--apply"] if args.apply else [])], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--weights-dir", type=Path, default=CACHE)
    parser.add_argument("--device", choices=("auto","mps","cpu"), default="auto")
    parser.add_argument("--field", choices=("editor","rotator"), default="rotator")
    parser.add_argument("--apply", action="store_true")
    bake(parser.parse_args())
