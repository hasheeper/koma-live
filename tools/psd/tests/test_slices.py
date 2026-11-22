import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import Tag

from layer_rig_psd.slices import export_slices


class SliceRoundTrip(unittest.TestCase):
    def test_source_ids_pixels_order_and_independent_reference(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = PSDImage.new("RGBA", (4, 3))
            for name, color, x, native_id in [("Back", "blue", -1, 10), ("Front", "red", 1, 11)]:
                layer = doc.create_pixel_layer(Image.new("RGBA", (3, 2), color), name=name, left=x)
                layer.tagged_blocks.set_data(Tag.LAYER_ID, native_id)
            source = root / "drawing.psd"
            doc.save(source)

            expected = Image.new("RGBA", (4, 3))
            expected.paste("blue", (0, 0, 2, 2))
            expected.paste("red", (1, 0, 4, 2))
            reference = root / "ref.png"
            expected.save(reference)
            output = root / "character"
            export_slices(source, reference, output, "paper", {})
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual((manifest['format'], manifest['blendSpace']), ('koma-rig.slices.v2', 'srgb'))
            layers = manifest["layers"]
            self.assertEqual([layer["layerId"] for layer in layers], ["psd-10", "psd-11"])
            self.assertEqual(layers[0]["rect"], [-1, 0, 3, 2])
            reconstructed = Image.new("RGBA", (4, 3))
            for layer in layers:
                with Image.open(output / layer["texture"]) as pixels:
                    reconstructed.alpha_composite(pixels, tuple(layer["rect"][:2]))
            self.assertEqual(reconstructed.tobytes(), expected.tobytes())
            with Image.open(output / manifest["reference"]) as actual:
                self.assertEqual(actual.tobytes(), expected.tobytes())
            masks = []
            for entry in layers:
                name = entry["layerId"] + ".png"
                Image.new("L", tuple(entry["rect"][2:]), 255).save(root / name)
                masks.append(dict(layerId=entry["layerId"], coverage=name))
            spec = root / "groups.json"
            spec.write_text(json.dumps([dict(opacity=0.5, members=masks)]))
            gel = root / "gel"
            export_slices(source, reference, gel, "paper", {}, gel_groups=spec)
            group = json.loads((gel / "manifest.json").read_text())["gelGroups"][0]
            self.assertEqual(group["opacity"], 0.5)
            self.assertTrue((gel / group["members"][0]["coverage"]).is_file())
            with self.assertRaises(ValueError):
                export_slices(source, reference, root / "invalid", "paper", {}, "linear", spec)
            legacy = root / "legacy"
            export_slices(source, reference, legacy, "paper", {}, "linear")
            self.assertEqual(json.loads((legacy / "manifest.json").read_text())["format"], "koma-rig.slices.v1")
            with self.assertRaises(ValueError):
                export_slices(source, reference, output, "paper", {})

    def test_nested_and_empty_groups_keep_identity_and_parent_links(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = PSDImage.new("RGBA", (4,4))
            pixel = doc.create_pixel_layer(Image.new("RGBA",(2,2),"red"), name="paint")
            subgroup = doc.create_group([pixel], name="same")
            empty = doc.create_group(name="same")
            parent = doc.create_group([subgroup,empty], name="folder")
            for layer, id in [(pixel,20), (subgroup,21), (empty,22), (parent,23)]:
                layer.tagged_blocks.set_data(Tag.LAYER_ID,id)
            doc.save(root/"source.psd")
            Image.new("RGBA",(4,4)).save(root/"ref.png")
            export_slices(root/"source.psd",root/"ref.png",root/"out","paper",{})
            manifest=json.loads((root/"out/manifest.json").read_text())
            groups={g["groupId"]:g for g in manifest["groupTree"]}
            self.assertEqual(groups["psd-21"]["parentGroupId"],"psd-23")
            self.assertEqual(groups["psd-22"]["parentGroupId"],"psd-23")
            self.assertEqual(manifest["layers"][0]["groupId"],"psd-21")

    def test_trim_stray_removes_corner_dust_and_preserves_connected_soft_edge(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = PSDImage.new("RGBA", (32, 32))
            img = Image.new("RGBA", (32, 32), (255, 255, 255, 2))  # canvas-wide haze
            img.putpixel((0, 0), (10, 10, 10, 30))  # isolated corner speck
            img.putpixel((31, 31), (10, 10, 10, 35))  # isolated opposite corner speck
            for y in range(12, 20):
                for x in range(12, 20):
                    img.putpixel((x, y), (200, 40, 80, 255))
            img.putpixel((11, 15), (200, 40, 80, 12))  # connected soft AA fringe
            layer = doc.create_pixel_layer(img, name="part", left=0, top=0)
            layer.tagged_blocks.set_data(Tag.LAYER_ID, 77)
            doc.save(root / "dirty.psd")

            ref = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            ref.save(root / "ref.png")
            export_slices(root / "dirty.psd", root / "ref.png", root / "clean", "demo", {}, trim_stray=True)
            manifest = json.loads((root / "clean/manifest.json").read_text())
            entry = manifest["layers"][0]
            # Tightly cropped around [12..20] + 3px halo -> [9..23], never 32x32
            self.assertLess(entry["rect"][2], 20)
            self.assertLess(entry["rect"][3], 20)
            with Image.open(root / "clean" / entry["texture"]) as tex:
                # Connected soft AA pixel (11, 15) preserved intact
                lx, ly = 11 - entry["rect"][0], 15 - entry["rect"][1]
                self.assertEqual(tex.getpixel((lx, ly)), (200, 40, 80, 12))

    def test_bake_reference_and_haze_cleanup_report(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = PSDImage.new("RGBA", (32, 32))
            img = Image.new("RGBA", (32, 32), (255, 255, 255, 2))  # canvas-wide haze
            for y in range(10, 22):
                for x in range(10, 22):
                    img.putpixel((x, y), (40, 120, 220, 255))
            layer = doc.create_pixel_layer(img, name="face_veil", left=0, top=0)
            layer.tagged_blocks.set_data(Tag.LAYER_ID, 88)
            doc.save(root / "haze.psd")

            out = root / "baked"
            report = export_slices(
                root / "haze.psd",
                None,
                out,
                "haze-demo",
                {},
                trim_stray=True,
                bake_reference=True,
            )
            self.assertTrue(report["bakedReference"])
            self.assertEqual(report["proof"]["mismatches"], 0)
            self.assertEqual(report["hazeWarnings"], ["psd-88"])
            self.assertEqual(len(report["trimmedLayers"]), 1)
            self.assertEqual(report["trimmedLayers"][0]["maxRemovedAlpha"], 2)
            self.assertTrue((out / "reference.png").is_file())
            with Image.open(out / "reference.png") as baked_ref:
                self.assertEqual(baked_ref.size, (32, 32))
                # Corner haze was removed before baking reference
                self.assertEqual(baked_ref.getpixel((0, 0))[3], 0)
                self.assertEqual(baked_ref.getpixel((15, 15)), (40, 120, 220, 255))

            with self.assertRaises(ValueError):
                export_slices(root / "haze.psd", None, root / "missing-ref", "haze-demo", {}, bake_reference=False)

    def test_skip_hidden_drops_locked_original_and_merged_copies(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = PSDImage.new("RGBA", (8, 8))
            locked = doc.create_pixel_layer(Image.new("RGBA", (8, 8), "black"), name="locked")
            merged = doc.create_pixel_layer(Image.new("RGBA", (4, 4), "blue"), name="merged")
            part = doc.create_pixel_layer(Image.new("RGBA", (4, 4), "red"), name="part")
            group = doc.create_group([merged, part], name="body")
            for layer, native in [(locked, 30), (merged, 31), (part, 32), (group, 33)]:
                layer.tagged_blocks.set_data(Tag.LAYER_ID, native)
            locked.visible = False
            merged.visible = False
            doc.save(root / "hidden.psd")

            report = export_slices(
                root / "hidden.psd", None, root / "out", "hidden-demo", {}, bake_reference=True, skip_hidden=True
            )
            manifest = json.loads((root / "out/manifest.json").read_text())
            self.assertEqual([layer["layerId"] for layer in manifest["layers"]], ["psd-32"])
            self.assertEqual([item["name"] for item in report["skippedHidden"]], ["locked", "merged"])
            self.assertEqual(report["proof"]["mismatches"], 0)

            full = export_slices(root / "hidden.psd", None, root / "full", "hidden-demo", {}, bake_reference=True)
            self.assertEqual(full["layerCount"], 3)
            self.assertEqual(full["skippedHidden"], [])
