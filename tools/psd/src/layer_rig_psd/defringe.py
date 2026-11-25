"""Automatic matte defringe (color-unmixing halo cleanup) for Koma Rig slice packages.

Removes white/black/custom-background cutout halos from semi-transparent anti-aliased borders
and 1-2px matte-contaminated opaque rims while preserving bright white art (white hair, lace,
highlights) and colored glows intact.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from layer_rig_psd.proof import compare, compose_package


def parse_matte_color(spec: str | tuple[int, int, int]) -> tuple[float, float, float]:
    """Parse a matte background color ('white', 'black', '#RRGGBB', or RGB tuple)."""
    if isinstance(spec, (tuple, list)):
        if len(spec) != 3:
            raise ValueError("matte 颜色须为 3 通道 RGB")
        return (float(spec[0]), float(spec[1]), float(spec[2]))
    raw = spec.strip().lower()
    if raw == "white":
        return (255.0, 255.0, 255.0)
    if raw == "black":
        return (0.0, 0.0, 0.0)
    if raw.startswith("#") and len(raw) == 7:
        try:
            return (
                float(int(raw[1:3], 16)),
                float(int(raw[3:5], 16)),
                float(int(raw[5:7], 16)),
            )
        except ValueError as exc:
            raise ValueError(f"无效的 matte 十六进制颜色：{spec}") from exc
    raise ValueError(f"不支持的 matte 颜色（请使用 white、black 或 #RRGGBB）：{spec}")


def _propagate_border_color(
    seed_mask: np.ndarray,
    src_rgb: np.ndarray,
    active_band: np.ndarray,
    iters: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Propagate clean interior seed RGB outward across a narrow active border band."""
    h, w = seed_mask.shape
    valid = seed_mask.copy()
    col = np.where(valid[..., None], src_rgb, 0.0)
    for _ in range(iters):
        need = active_band & (~valid)
        if not need.any():
            break
        sum_c = np.zeros((h, w, 3), dtype=np.float32)
        cnt = np.zeros((h, w), dtype=np.float32)
        for dy in (-1, 0, 1):
            y0s, y1s = max(0, -dy), h - max(0, dy)
            y0d, y1d = max(0, dy), h - max(0, -dy)
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                x0s, x1s = max(0, -dx), w - max(0, dx)
                x0d, x1d = max(0, dx), w - max(0, -dx)
                v = valid[y0s:y1s, x0s:x1s]
                # Restrict accumulation to pixels that actually need filling or propagate cleanly
                sum_c[y0d:y1d, x0d:x1d] += np.where(v[..., None], col[y0s:y1s, x0s:x1s], 0.0)
                cnt[y0d:y1d, x0d:x1d] += v.astype(np.float32)
        fill = need & (cnt > 0.0)
        if not fill.any():
            break
        col[fill] = sum_c[fill] / cnt[fill, None]
        valid[fill] = True
    return col, valid


def defringe_matte_report(
    pixels: Image.Image,
    matte: str | tuple[int, int, int] = "white",
    strength: float = 1.0,
    max_rim_passes: int = 2,
) -> tuple[Image.Image, dict]:
    """Unmix matte-background halo along transparency borders without harming bright white art.

    For a boundary pixel observed as ``C_obs = (1 - t) * F_inner + t * M`` with alpha ``a``,
    removing the unwanted matte ``M`` yields exact analytical foreground recovery:
    ``C_new = F_inner`` (plus attenuated perpendicular nuance) and ``a_new = a * (1 - t)``.
    Over the original matte background ``M`` the composite stays bit-identical; over dark
    or contrasting stages the white/colored fringe vanishes completely.
    """
    if not (0.0 <= strength <= 1.0):
        raise ValueError("strength 须在 0.0 到 1.0 之间")
    if max_rim_passes < 0 or max_rim_passes > 3:
        raise ValueError("max_rim_passes 须在 0 到 3 之间")

    matte_rgb = parse_matte_color(matte)
    rgba_u8 = np.asarray(pixels.convert("RGBA"))
    if strength == 0.0 or rgba_u8.size == 0:
        return pixels.convert("RGBA").copy(), dict(
            changedPixels=0, semiMattePixels=0, rimPixels=0, meanMatteFraction=0.0, changed=False
        )

    rgba = rgba_u8.astype(np.float32)
    h, w = rgba.shape[:2]
    rgb = rgba[..., :3]
    a = rgba[..., 3] / 255.0
    matte_vec = np.array(matte_rgb, dtype=np.float32)

    opaque = a >= (248.0 / 255.0)
    if not opaque.any():
        return Image.fromarray(rgba_u8.copy(), mode="RGBA"), dict(
            changedPixels=0, semiMattePixels=0, rimPixels=0, meanMatteFraction=0.0, changed=False
        )

    op_u8 = (opaque.astype(np.uint8) * 255)
    eroded1 = np.asarray(Image.fromarray(op_u8, mode="L").filter(ImageFilter.MinFilter(3))) > 0
    eroded2 = np.asarray(Image.fromarray(op_u8, mode="L").filter(ImageFilter.MinFilter(5))) > 0

    # Active border band covers semi-transparent edge + outermost 2px opaque rim only
    active_band = (a > 0.0) & (~eroded2)
    if not active_band.any():
        return Image.fromarray(rgba_u8.copy(), mode="RGBA"), dict(
            changedPixels=0, semiMattePixels=0, rimPixels=0, meanMatteFraction=0.0, changed=False
        )

    # Propagate interior seed colors strictly across the narrow active band (fast!)
    f2, v2 = _propagate_border_color(eroded2, rgb, active_band, iters=4)
    f1, v1 = _propagate_border_color(eroded1, rgb, active_band, iters=3)
    f0, v0 = _propagate_border_color(opaque, rgb, active_band, iters=3)

    # Thin dark-outline guard: if eroded1 is significantly closer to non-matte than eroded2
    # (e.g. a 1-2px dark lineart stroke bordering bright skin/white cloth), keep the dark outline!
    dist_m2 = np.sqrt(np.sum((f2 - matte_vec[None, None, :]) ** 2, axis=-1))
    dist_m1 = np.sqrt(np.sum((f1 - matte_vec[None, None, :]) ** 2, axis=-1))
    use_f1 = v1 & ((~v2) | (dist_m1 > dist_m2 + 45.0))
    F = np.where(use_f1[..., None], f1, np.where(v2[..., None], f2, f0))
    valid_F = v2 | v1 | v0

    # Exact vector projection of (C_obs - F) onto matte direction d = M - F
    d = matte_vec[None, None, :] - F
    d2 = np.sum(d * d, axis=-1)
    d_norm = np.sqrt(d2)

    diff = rgb - F
    t_raw = np.divide(np.sum(diff * d, axis=-1), d2, out=np.zeros((h, w), dtype=np.float32), where=d2 > 1e-4)
    t_clamped = np.clip(t_raw, 0.0, 0.985)
    proj = F + t_clamped[..., None] * d
    resid = np.sqrt(np.sum((rgb - proj) ** 2, axis=-1))

    # Pass 1: Semi-transparent anti-aliased boundary pixels (0 < alpha < 248)
    # Gate: interior must have real contrast vs matte (d_norm >= 30, protecting white lace/snow hair)
    # and observed color must lie collinearly toward matte (resid <= 36, protecting colored glows).
    semi = (a > 0.0) & (~opaque) & valid_F
    semi_matte = semi & (d_norm >= 30.0) & (t_raw >= 0.07) & (resid <= 36.0)

    # Pass 2: Matte-contaminated 1px (and optionally 2px) opaque cutout rim
    rim_total = np.zeros((h, w), dtype=bool)
    if max_rim_passes >= 1:
        semi_dil = (
            np.asarray(Image.fromarray((semi_matte.astype(np.uint8) * 255), mode="L").filter(ImageFilter.MaxFilter(3)))
            > 0
        )
        zero_dil = (
            np.asarray(Image.fromarray(((a == 0.0).astype(np.uint8) * 255), mode="L").filter(ImageFilter.MaxFilter(3)))
            > 0
        )
        rim1_base = opaque & (~eroded1) & valid_F
        rim1_soft = rim1_base & semi_dil & (d_norm >= 42.0) & (t_raw >= 0.14) & (resid <= 26.0)
        rim1_hard = rim1_base & zero_dil & (d_norm >= 55.0) & (t_raw >= 0.52) & (resid <= 22.0)
        rim1 = rim1_soft | rim1_hard
        rim_total |= rim1

        if max_rim_passes >= 2 and rim1.any():
            strong_rim1 = rim1 & (t_raw >= 0.42)
            if strong_rim1.any():
                s1_dil = (
                    np.asarray(
                        Image.fromarray((strong_rim1.astype(np.uint8) * 255), mode="L").filter(
                            ImageFilter.MaxFilter(3)
                        )
                    )
                    > 0
                )
                rim2 = (
                    opaque
                    & eroded1
                    & (~eroded2)
                    & s1_dil
                    & valid_F
                    & (d_norm >= 55.0)
                    & (t_raw >= 0.22)
                    & (resid <= 22.0)
                )
                rim_total |= rim2

    fix = semi_matte | rim_total
    changed_count = int(fix.sum())
    if changed_count == 0:
        return Image.fromarray(rgba_u8.copy(), mode="RGBA"), dict(
            changedPixels=0, semiMattePixels=0, rimPixels=0, meanMatteFraction=0.0, changed=False
        )

    t_eff = np.where(fix, np.clip(t_clamped * strength, 0.0, 0.985), 0.0)
    out_rgb = rgb.copy()
    out_a = a.copy()
    out_rgb[fix] = np.clip(F[fix] + (rgb[fix] - proj[fix]) * (1.0 - t_eff[fix, None]), 0.0, 255.0)
    out_a[fix] = a[fix] * (1.0 - t_eff[fix])

    # Clear negligible sub-1/255 alpha dust left behind by 98%+ matte pixels
    dust = out_a < (1.5 / 255.0)
    out_a[dust] = 0.0
    out_rgb[dust] = 0.0

    out = np.zeros_like(rgba_u8)
    out[..., :3] = np.clip(np.rint(out_rgb), 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(np.rint(out_a * 255.0), 0, 255).astype(np.uint8)

    stats = dict(
        changedPixels=changed_count,
        semiMattePixels=int(semi_matte.sum()),
        rimPixels=int(rim_total.sum()),
        meanMatteFraction=round(float(t_eff[fix].mean()), 4),
        changed=True,
    )
    return Image.fromarray(out, mode="RGBA"), stats


def defringe_matte(
    pixels: Image.Image,
    matte: str | tuple[int, int, int] = "white",
    strength: float = 1.0,
    max_rim_passes: int = 2,
) -> Image.Image:
    """Return a matte-defringed copy of an RGBA image."""
    image, _ = defringe_matte_report(pixels, matte=matte, strength=strength, max_rim_passes=max_rim_passes)
    return image


def resolve_slices_dir(target: Path) -> Path:
    """Resolve either a slices directory (with manifest.json) or a Koma work directory (with koma-work.json)."""
    if (target / "manifest.json").exists():
        return target
    work_file = target / "koma-work.json" if target.is_dir() else target
    if work_file.is_file() and work_file.name.endswith(".json"):
        work = json.loads(work_file.read_text(encoding="utf-8"))
        if isinstance(work, dict) and isinstance(work.get("rig"), str):
            resolved = (work_file.parent / work["rig"]).resolve()
            if (resolved / "manifest.json").exists():
                return resolved
    raise ValueError(f"找不到切片清单 manifest.json：{target}")


def defringe_slices(
    target: Path,
    matte: str = "white",
    strength: float = 1.0,
    max_rim_passes: int = 2,
    layers: set[str] | None = None,
    exclude: set[str] | None = None,
    include_hidden: bool = False,
    dry_run: bool = False,
    rebake_reference: bool = True,
) -> dict:
    """Run automatic matte defringe across textures in an existing slice package and rebake reference.png."""
    slices_dir = resolve_slices_dir(target)
    manifest_path = slices_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Collect gel-group members (coverage masks must not be mismatched against paint alpha!)
    gel_member_ids = {
        m["layerId"]
        for g in (manifest.get("gelGroups") or [])
        for m in (g.get("members") or [])
    }

    processed = 0
    changed_layers = []
    total_changed = 0
    total_semi = 0
    total_rim = 0

    for entry in manifest["layers"]:
        lid = entry["layerId"]
        if layers is not None and lid not in layers:
            continue
        if exclude is not None and lid in exclude:
            continue
        if layers is None and not include_hidden and not entry.get("visible", True):
            continue
        # Preserve gel-group coverage invariant unless explicitly targeted
        if layers is None and lid in gel_member_ids:
            continue

        tex_path = slices_dir / entry["texture"]
        with Image.open(tex_path) as src:
            cleaned, stats = defringe_matte_report(
                src, matte=matte, strength=strength, max_rim_passes=max_rim_passes
            )
        processed += 1
        if stats["changed"]:
            if not dry_run:
                cleaned.save(tex_path)
            total_changed += stats["changedPixels"]
            total_semi += stats["semiMattePixels"]
            total_rim += stats["rimPixels"]
            changed_layers.append(dict(layerId=lid, name=entry.get("name", lid), **stats))

    proof_report = None
    if not dry_run and rebake_reference and total_changed > 0:
        actual = compose_package(slices_dir, manifest)
        unpremul = actual.copy()
        alpha = unpremul[..., 3:]
        unpremul[..., :3] = np.divide(
            unpremul[..., :3], alpha, out=np.zeros_like(unpremul[..., :3]), where=alpha > 0
        )
        Image.fromarray(np.rint(np.clip(unpremul, 0, 1) * 255).astype(np.uint8), mode="RGBA").save(
            slices_dir / manifest.get("reference", "reference.png")
        )
        proof_report = compare(slices_dir, manifest, actual, tolerance=1)

    report = dict(
        dir=str(slices_dir),
        matte=matte,
        strength=strength,
        maxRimPasses=max_rim_passes,
        dryRun=dry_run,
        layersProcessed=processed,
        layersChanged=len(changed_layers),
        totalChangedPixels=total_changed,
        totalSemiMattePixels=total_semi,
        totalRimPixels=total_rim,
        layers=changed_layers,
    )
    if proof_report is not None:
        report["proof"] = proof_report
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="自动清理切片包抠图白边/黑边杂色（颜色逆混合算法）")
    parser.add_argument("target", type=Path, help="切片目录（含 manifest.json）或作品目录（含 koma-work.json）")
    parser.add_argument("--matte", default="white", help="抠图底色：white（默认）、black 或 #RRGGBB")
    parser.add_argument("--strength", type=float, default=1.0, help="去边强度 0.0~1.0（默认 1.0）")
    parser.add_argument("--max-rim-passes", type=int, default=2, help="实心边缘穿透修边层数 0~3（默认 2）")
    parser.add_argument("--layers", help="仅处理指定图层 ID（逗号分隔）")
    parser.add_argument("--exclude", help="跳过指定图层 ID（逗号分隔）")
    parser.add_argument("--include-hidden", action="store_true", help="连同隐藏图层一并处理")
    parser.add_argument("--no-rebake", action="store_true", help="跳过自动重烘 reference.png")
    parser.add_argument("--dry-run", action="store_true", help="仅统计受影响像素与图层，不写回磁盘")
    args = parser.parse_args()
    try:
        layers = {s.strip() for s in args.layers.split(",") if s.strip()} if args.layers else None
        exclude = {s.strip() for s in args.exclude.split(",") if s.strip()} if args.exclude else None
        report = defringe_slices(
            args.target,
            matte=args.matte,
            strength=args.strength,
            max_rim_passes=args.max_rim_passes,
            layers=layers,
            exclude=exclude,
            include_hidden=args.include_hidden,
            dry_run=args.dry_run,
            rebake_reference=not args.no_rebake,
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
