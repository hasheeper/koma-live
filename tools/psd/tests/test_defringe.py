from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image
from psd_tools import PSDImage

from layer_rig_psd.defringe import defringe_matte_report, defringe_slices
from layer_rig_psd.slices import export_slices


def _composite_over(rgba: np.ndarray, bg_rgb: tuple[int, int, int]) -> np.ndarray:
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = rgba[..., :3].astype(np.float32)
    bg = np.array(bg_rgb, dtype=np.float32)[None, None, :]
    return rgb * a + bg * (1.0 - a)


class DefringeTests(unittest.TestCase):
    def test_recovers_true_color_and_preserves_white_composite(self):
        arr = np.zeros((24, 24, 4), dtype=np.uint8)
        fg = np.array([60.0, 90.0, 100.0])
        arr[5:19, 5:19] = [60, 90, 100, 255]
        # Semi-transparent border contaminated 75% by white background
        mixed = np.rint(0.25 * fg + 0.75 * 255.0).astype(np.uint8)
        arr[4, 5:19] = [*mixed, 220]
        arr[19, 5:19] = [*mixed, 220]
        arr[5:19, 4] = [*mixed, 220]
        arr[5:19, 19] = [*mixed, 220]
        # 1px opaque rim contaminated 30% by white
        rim = np.rint(0.70 * fg + 0.30 * 255.0).astype(np.uint8)
        arr[5, 5:19] = [*rim, 255]

        cleaned, stats = defringe_matte_report(Image.fromarray(arr, mode="RGBA"), matte="white", strength=1.0)
        out = np.asarray(cleaned)

        self.assertTrue(stats["changed"])
        self.assertGreaterEqual(stats["semiMattePixels"], 56)
        self.assertGreaterEqual(stats["rimPixels"], 12)

        # Composite over white must stay virtually identical
        white_before = _composite_over(arr, (255, 255, 255))
        white_after = _composite_over(out, (255, 255, 255))
        self.assertLessEqual(float(np.max(np.abs(white_before - white_after))), 2.5)

        # Composite over dark must lose the glaring white halo
        dark_before = _composite_over(arr, (20, 22, 28))
        dark_after = _composite_over(out, (20, 22, 28))
        self.assertGreater(float(dark_before[4, 10].mean()), 160.0)
        self.assertLess(float(dark_after[4, 10].mean()), 45.0)
        self.assertLessEqual(abs(int(out[4, 10, 0]) - 60), 3)
        self.assertLessEqual(abs(int(out[4, 10, 1]) - 90), 3)
        self.assertLessEqual(abs(int(out[4, 10, 2]) - 100), 3)

    def test_preserves_white_lace_and_colored_glows(self):
        lace = np.zeros((20, 20, 4), dtype=np.uint8)
        lace[4:16, 4:16] = [248, 250, 254, 255]
        lace[3, 4:16] = [250, 251, 255, 110]
        cleaned_lace, lace_stats = defringe_matte_report(Image.fromarray(lace, mode="RGBA"), matte="white")
        self.assertEqual(lace_stats["changedPixels"], 0)
        self.assertTrue(np.array_equal(np.asarray(cleaned_lace), lace))

        horn = np.zeros((20, 20, 4), dtype=np.uint8)
        horn[5:15, 5:15] = [18, 12, 16, 255]
        horn[4, 5:15] = [235, 25, 55, 140]  # saturated crimson glow (non-collinear with white)
        cleaned_horn, horn_stats = defringe_matte_report(Image.fromarray(horn, mode="RGBA"), matte="white")
        self.assertEqual(horn_stats["changedPixels"], 0)
        self.assertTrue(np.array_equal(np.asarray(cleaned_horn), horn))

    def test_thin_dark_outline_does_not_bleed_interior_skin(self):
        arr = np.zeros((24, 24, 4), dtype=np.uint8)
        arr[6:18, 6:18] = [252, 240, 234, 255]
        arr[4:20, 4:6] = [95, 65, 58, 255]
        arr[4:20, 18:20] = [95, 65, 58, 255]
        arr[4:6, 4:20] = [95, 65, 58, 255]
        arr[18:20, 4:20] = [95, 65, 58, 255]
        halo = np.rint(0.35 * np.array([95, 65, 58]) + 0.65 * 255.0).astype(np.uint8)
        arr[4:20, 3] = [*halo, 180]

        cleaned, stats = defringe_matte_report(Image.fromarray(arr, mode="RGBA"), matte="white")
        out = np.asarray(cleaned)
        self.assertTrue(stats["changed"])
        self.assertLess(int(out[10, 3, 0]), 120)
        self.assertLess(int(out[10, 3, 1]), 90)
        self.assertLess(int(out[10, 3, 2]), 85)
        self.assertTrue(np.array_equal(out[10, 10], [252, 240, 234, 255]))

    def test_defringe_slices_and_export_slices_integration(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            canvas = np.zeros((24, 24, 4), dtype=np.uint8)
            canvas[5:19, 5:19] = [40, 50, 60, 255]
            canvas[4, 5:19] = [205, 208, 212, 210]

            psd = PSDImage.new("RGBA", (24, 24))
            psd.create_pixel_layer(Image.fromarray(canvas, mode="RGBA"), name="body")
            psd_path = root / "sample.psd"
            psd.save(psd_path)

            raw_dir = root / "slices-raw"
            export_slices(psd_path, None, raw_dir, "sample", {"0": "body"}, bake_reference=True)
            dry_report = defringe_slices(raw_dir, matte="white", dry_run=True)
            self.assertEqual(dry_report["layersChanged"], 1)
            self.assertGreaterEqual(dry_report["totalChangedPixels"], 14)

            live_report = defringe_slices(raw_dir, matte="white", dry_run=False)
            self.assertEqual(live_report["layersChanged"], 1)
            self.assertEqual(live_report["proof"]["mismatches"], 0)

            clean_dir = root / "slices-clean"
            exp_report = export_slices(
                psd_path, None, clean_dir, "sample", {"0": "body"}, bake_reference=True, defringe="white"
            )
            self.assertEqual(exp_report["defringe"], "white")
            self.assertEqual(len(exp_report["defringedLayers"]), 1)
            self.assertEqual(exp_report["proof"]["mismatches"], 0)

            a = np.asarray(Image.open(raw_dir / "textures/0.png"))
            b = np.asarray(Image.open(clean_dir / "textures/0.png"))
            self.assertTrue(np.array_equal(a, b))


if __name__ == "__main__":
    unittest.main()
