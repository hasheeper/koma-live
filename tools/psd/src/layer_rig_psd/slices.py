"""Export a new static slice directory from art-approved raster layers."""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image, ImageFilter
from psd_tools import PSDImage
from psd_tools.constants import BlendMode, ColorMode

from layer_rig_psd.proof import compare, compose_package


def trim_stray_alpha_report(
    pixels: Image.Image,
    strong_thresh: int = 40,
    weak_thresh: int = 6,
    halo_radius: int = 3,
) -> tuple[Image.Image, int, int, dict]:
    """Remove disconnected low-alpha corner dust/matte haze while preserving connected soft edges."""
    rgba = np.asarray(pixels.convert("RGBA")).copy()
    orig_h, orig_w = rgba.shape[:2]
    alpha = rgba[..., 3]
    strong = alpha >= strong_thresh
    if not strong.any():
        stats = dict(
            originalSize=[orig_w, orig_h],
            trimmedSize=[orig_w, orig_h],
            offset=[0, 0],
            removedPixels=0,
            maxRemovedAlpha=0,
            hazeWarning=False,
            changed=False,
        )
        return Image.fromarray(rgba, mode="RGBA"), 0, 0, stats

    weak = alpha >= weak_thresh
    mask = strong.copy()
    while True:
        grown = (
            np.asarray(Image.fromarray((mask.astype(np.uint8) * 255), mode="L").filter(ImageFilter.MaxFilter(3))) > 0
        ) & weak
        if np.array_equal(grown, mask):
            break
        mask = grown
    keep = (
        np.asarray(
            Image.fromarray((mask.astype(np.uint8) * 255), mode="L").filter(
                ImageFilter.MaxFilter(halo_radius * 2 + 1)
            )
        )
        > 0
    )

    removed_mask = (alpha > 0) & (~keep)
    removed_pixels = int(removed_mask.sum())
    if removed_pixels > 0:
        removed_alphas = alpha[removed_mask]
        max_removed_alpha = int(removed_alphas.max())
        p90_removed_alpha = float(np.percentile(removed_alphas, 90))
    else:
        max_removed_alpha = 0
        p90_removed_alpha = 0.0

    rgba[~keep] = 0
    ys, xs = np.where(rgba[..., 3] > 0)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    new_w, new_h = x1 - x0, y1 - y0
    haze_warning = bool(
        removed_pixels > 0
        and p90_removed_alpha <= 12
        and (removed_pixels / max(1, orig_w * orig_h)) >= 0.25
    )
    stats = dict(
        originalSize=[orig_w, orig_h],
        trimmedSize=[new_w, new_h],
        offset=[x0, y0],
        removedPixels=removed_pixels,
        maxRemovedAlpha=max_removed_alpha,
        hazeWarning=haze_warning,
        changed=bool(removed_pixels > 0 or new_w != orig_w or new_h != orig_h),
    )
    return Image.fromarray(rgba[y0:y1, x0:x1], mode="RGBA"), x0, y0, stats


def trim_stray_alpha(
    pixels: Image.Image,
    strong_thresh: int = 40,
    weak_thresh: int = 6,
    halo_radius: int = 3,
) -> tuple[Image.Image, int, int]:
    """Remove disconnected low-alpha corner dust/matte haze while preserving connected soft edges."""
    image, dx, dy, _ = trim_stray_alpha_report(pixels, strong_thresh, weak_thresh, halo_radius)
    return image, dx, dy


def export_gel_groups(spec: Path, package: Path, entries: list[dict]) -> list[dict]:
    groups = json.loads(spec.read_text(encoding="utf-8"))
    if not isinstance(groups, list):
        raise ValueError("同深度合成组描述须为数组")
    order = {entry["layerId"]: i for i, entry in enumerate(entries)}
    claimed = set()
    result = []
    for group in groups:
        if not isinstance(group, dict):
            raise ValueError("同深度合成组须为对象")
        opacity, members = group.get("opacity"), group.get("members")
        if type(opacity) not in (int, float) or not 0 <= opacity <= 1 or not isinstance(members, list) or not members:
            raise ValueError("同深度合成组须给出有效不透明度和有序成员")
        previous = None
        exported = []
        for member in members:
            if not isinstance(member, dict) or not isinstance(member.get("coverage"), str):
                raise ValueError("合成组成员须指定轮廓 PNG")
            layer_id = member.get("layerId")
            index = order.get(layer_id) if isinstance(layer_id, str) else None
            if index is None or layer_id in claimed or (previous is not None and index != previous + 1):
                raise ValueError(f"同深度合成组须使用唯一且连续的原层序：{layer_id}")
            previous = index
            claimed.add(layer_id)
            layer = entries[index]
            path = f"textures/coverage-{index}.png"
            with Image.open(spec.parent / member["coverage"]) as source:
                if source.format != "PNG" or source.mode not in ("L", "RGBA") or list(source.size) != layer["rect"][2:]:
                    raise ValueError(f"轮廓须为同尺寸 8 位灰度或 RGBA PNG：{layer_id}")
                mask = source.getchannel("A") if source.mode == "RGBA" else source.copy()
            with Image.open(package / layer["texture"]) as paint:
                if np.any(np.asarray(paint.getchannel("A")) * layer["opacity"] > np.asarray(mask).astype(float) + 1):
                    raise ValueError(f"画色超出覆盖轮廓：{layer_id}")
            coverage = Image.new("RGBA", mask.size, "white")
            coverage.putalpha(mask)
            coverage.save(package / path)
            exported.append(dict(layerId=layer_id, coverage=path))
        result.append(dict(opacity=opacity, members=exported))
    return result


def export_slices(
    source: Path,
    reference: Path | None,
    output: Path,
    source_id: str,
    ids: dict,
    blend_space: str = "srgb",
    gel_groups: Path | None = None,
    trim_stray: bool = False,
    bake_reference: bool = False,
    skip_hidden: bool = False,
) -> dict:
    if blend_space not in ("srgb", "linear") or (gel_groups and blend_space != "srgb"):
        raise ValueError("同深度合成组使用 sRGB 直接预乘切片包")
    if output.exists():
        raise ValueError(f"输出目录已存在：{output}")
    if not source_id.strip():
        raise ValueError("sourceId 不能为空")
    if bake_reference and reference is not None:
        raise ValueError("使用 --bake-reference 自动烘焙基准图时无需再传独立参考 PNG")
    if not bake_reference and reference is None:
        raise ValueError("请提供独立参考 PNG，或使用 --bake-reference 自动烘焙基准图")

    psd = PSDImage.open(source)
    if psd.depth != 8 or psd.color_mode != ColorMode.RGB:
        raise ValueError("请先将源稿导出为 8 位 RGB PSD")

    reference_image = None
    if reference is not None:
        with Image.open(reference) as original:
            if original.format != "PNG" or original.size != psd.size or original.mode not in ("RGB", "RGBA"):
                raise ValueError("请提供同画布尺寸的独立 sRGB RGB/RGBA 参考 PNG")
            # Normalize encoding only. Reference pixels come exclusively from the supplied image.
            reference_image = original.convert("RGBA")

    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as temp:
        package = Path(temp) / "package"
        textures = package / "textures"
        textures.mkdir(parents=True)
        entries = []
        seen = set()
        trimmed_layers = []

        tree = []
        group_ids = set()
        skipped_hidden = []

        def visit(parent, groups, indices, parent_group_id=None):
            # psd-tools iterates in compositing order (back to front).
            for index, layer in enumerate(parent):
                address = (*indices, str(index))
                if skip_hidden and not layer.visible:
                    skipped_hidden.append(dict(path="/".join(address), name=layer.name))
                    continue
                if layer.has_mask() or layer.has_vector_mask() or layer.has_effects() or layer.clipping:
                    raise ValueError(f"请先在美术侧烘焙蒙版、剪贴与效果：{layer.name}")
                if layer.is_group():
                    if layer.blend_mode not in (BlendMode.PASS_THROUGH, BlendMode.NORMAL) or layer.opacity != 255:
                        raise ValueError(f"请先烘焙组混合与不透明度：{layer.name}")
                    key = "/".join(address)
                    native = layer.layer_id
                    group_id = ids.get(key, f"psd-{native}" if native >= 0 else f"group-index:{key}")
                    source_kind = "mapped" if key in ids else "native" if native >= 0 else "index"
                    if not isinstance(group_id, str) or not group_id or group_id in group_ids:
                        raise ValueError(f"请用 --id-map 为组 {key} ({layer.name}) 指定唯一 ID")
                    group_ids.add(group_id)
                    tree.append(
                        dict(
                            groupId=group_id,
                            parentGroupId=parent_group_id,
                            name=layer.name,
                            visible=layer.visible,
                            index=index,
                            idSource=source_kind,
                        )
                    )
                    visit(layer, [*groups, layer.name], address, group_id)
                    continue
                if layer.kind != "pixel" or layer.blend_mode != BlendMode.NORMAL or layer.fill_opacity != 255:
                    raise ValueError(f"请先导出普通栅格部件：{layer.name}")
                key = "/".join(address)
                layer_id = ids.get(key, f"psd-{layer.layer_id}" if layer.layer_id >= 0 else None)
                if not isinstance(layer_id, str) or not layer_id or layer_id in seen:
                    raise ValueError(f"请用 --id-map 为 {key} ({layer.name}) 显式指定唯一 ID")
                seen.add(layer_id)
                pixels = layer.topil()
                if pixels is None or min(pixels.size) <= 0:
                    raise ValueError(f"空切片：{layer.name}")
                dx = dy = 0
                if trim_stray:
                    pixels, dx, dy, trim_stats = trim_stray_alpha_report(pixels)
                    if trim_stats["changed"]:
                        trimmed_layers.append(dict(layerId=layer_id, name=layer.name, **trim_stats))
                texture = f"textures/{len(entries)}.png"
                pixels.convert("RGBA").save(package / texture)
                entries.append(
                    dict(
                        layerId=layer_id,
                        name=layer.name,
                        groups=groups,
                        texture=texture,
                        sourceIndex=index,
                        rect=[layer.left + dx, layer.top + dy, *pixels.size],
                        visible=layer.is_visible(),
                        opacity=layer.opacity / 255,
                    )
                )

                if parent_group_id is not None:
                    entries[-1]["groupId"] = parent_group_id

        visit(psd, [], ())
        manifest = dict(
            format="koma-rig.slices.v1" if blend_space == "linear" else "koma-rig.slices.v2",
            sourceId=source_id,
            canvas=dict(width=psd.width, height=psd.height),
            reference="reference.png",
            layers=entries,
        )
        if tree:
            manifest["groupTree"] = tree
        else:
            for entry in entries:
                del entry["sourceIndex"]
        if blend_space == "srgb":
            manifest["blendSpace"] = "srgb"
            if gel_groups:
                manifest["gelGroups"] = export_gel_groups(gel_groups, package, entries)

        proof_report = None
        if bake_reference:
            actual = compose_package(package, manifest)
            unpremul = actual.copy()
            alpha = unpremul[..., 3:]
            unpremul[..., :3] = np.divide(
                unpremul[..., :3], alpha, out=np.zeros_like(unpremul[..., :3]), where=alpha > 0
            )
            Image.fromarray(np.rint(np.clip(unpremul, 0, 1) * 255).astype(np.uint8), mode="RGBA").save(
                package / "reference.png"
            )
            proof_report = compare(package, manifest, actual, tolerance=1)
        else:
            assert reference_image is not None
            reference_image.save(package / "reference.png")

        (package / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        package.rename(output)

    report = dict(
        output=str(output),
        sourceId=source_id,
        format=manifest["format"],
        blendSpace=blend_space,
        canvas=manifest["canvas"],
        layerCount=len(entries),
        groupCount=len(tree),
        bakedReference=bake_reference,
        trimStray=trim_stray,
        skipHidden=skip_hidden,
        skippedHidden=skipped_hidden,
        trimmedLayers=trimmed_layers,
        hazeWarnings=[item["layerId"] for item in trimmed_layers if item["hazeWarning"]],
    )
    if proof_report is not None:
        report["proof"] = proof_report
    return report


def main():
    parser = argparse.ArgumentParser(description="离线导出已烘焙的栅格切片包")
    parser.add_argument("source", type=Path, help="源 PSD 文件路径")
    parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="传 <reference.png> <output_dir>；若开启 --bake-reference 则只需传 <output_dir>",
    )
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--blend-space", choices=("srgb", "linear"), default="srgb")
    parser.add_argument("--gel-groups", type=Path, help="同深度组及美术确认的轮廓 PNG 映射")
    parser.add_argument("--id-map", type=Path, help="本次源稿层索引路径到持久 layerId 的人工映射 JSON")
    parser.add_argument("--trim-stray", action="store_true", help="清理孤立低透明噪点并紧致裁切各切片边界（保留连通柔边）")
    parser.add_argument(
        "--bake-reference",
        action="store_true",
        help="按当前 blend-space 与清理后图层直接烘焙 reference.png 并执行 0 误差复验（无需提供外部参考图）",
    )
    parser.add_argument(
        "--skip-hidden",
        action="store_true",
        help="跳过 PSD 中隐藏的图层与组（如锁定原图、组内合并副本），不写入切片包",
    )
    parser.add_argument("--report", type=Path, help="将导出与去噪体检报告写入指定 JSON 文件")
    args = parser.parse_args()
    try:
        if args.bake_reference:
            if len(args.paths) != 1:
                raise ValueError("开启 --bake-reference 时只需传入 1 个输出目录：<source.psd> <output_dir>")
            reference, output = None, args.paths[0]
        else:
            if len(args.paths) != 2:
                raise ValueError("请传入 <source.psd> <reference.png> <output_dir>（或加 --bake-reference 省略参考图）")
            reference, output = args.paths[0], args.paths[1]

        ids = json.loads(args.id_map.read_text(encoding="utf-8")) if args.id_map else {}
        if not isinstance(ids, dict):
            raise ValueError("ID 映射应为 JSON 对象")
        report = export_slices(
            args.source,
            reference,
            output,
            args.source_id,
            ids,
            args.blend_space,
            args.gel_groups,
            trim_stray=args.trim_stray,
            skip_hidden=args.skip_hidden,
            bake_reference=args.bake_reference,
        )
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
