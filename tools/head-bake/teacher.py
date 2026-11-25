"""Run the pinned THA3 pipeline and expose geometrical outputs separately from RGB."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from fetch_tha3 import SOURCE, WEIGHTS


def to_image(tensor):
    image = tensor[0].detach().float().cpu().numpy().transpose(1, 2, 0)
    image = np.clip((image + 1) / 2, 0, 1)
    rgb = image[..., :3]
    image[..., :3] = np.where(rgb <= .0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - .055)
    return Image.fromarray(np.rint(image * 255).astype("uint8"))


class Teacher:
    def __init__(self, root, device):
        import torch
        sys.path.insert(0, str(root / "source"))
        from tha3.poser.modes import separable_float as mode
        from tha3.poser.modes.pose_parameters import get_pose_parameters
        from tha3.nn.editor.editor_07 import Editor07
        from tha3.nn.two_algo_body_rotator.two_algo_face_body_rotator_05 import TwoAlgoFaceBodyRotator05 as Rotator
        from tha3.util import extract_pytorch_image_from_PIL_image
        self.torch = torch
        self.device = device
        if device == "mps":
            # macOS 14's MPS kernel cannot sample with border padding. Keep the five
            # networks on the GPU and perform only this particular warp on the CPU.
            from tha3.nn import image_processing_util
            def grid_sample(image, grid, **options):
                return torch.nn.functional.grid_sample(image.cpu(), grid.cpu(), **options).to(image.device)
            image_processing_util.grid_sample = grid_sample
        self.convert = extract_pytorch_image_from_PIL_image
        params = get_pose_parameters()
        self.yaw = params.get_parameter_index("head_y")
        self.pitch = params.get_parameter_index("head_x")
        assert (self.yaw, self.pitch, params.get_parameter_count()) == (40, 39, 45)
        self.files = {name: str(root / "separable_float" / (name + ".pt")) for name in WEIGHTS}
        for name, path in self.files.items():
            if hashlib.sha256(Path(path).read_bytes()).hexdigest() != WEIGHTS[name]:
                raise ValueError(f"Invalid {path}, run fetch_tha3.py")
        # Upstream weights may retain a training-device tag. Materialize on CPU first.
        mode.torch_load = lambda path: torch.load(path, map_location="cpu", weights_only=True)
        self.coarse = Editor07.OUTPUT_LENGTH + Rotator.GRID_CHANGE_INDEX
        self.fine = Editor07.GRID_CHANGE_INDEX
        self.mask = Editor07.COLOR_CHANGE_ALPHA_INDEX
        self.warps = (Editor07.OUTPUT_LENGTH + Rotator.WARPED_IMAGE_INDEX, Editor07.WARPED_IMAGE_INDEX)
        self.poser = mode.create_poser(torch.device(device), self.files)

    def run(self, image, yaw, pitch):
        torch = self.torch
        with torch.inference_mode():
            tensor = self.convert(image.copy()).unsqueeze(0).to(self.device)
            params = torch.zeros(1, 45, device=self.device)
            params[0, self.yaw], params[0, self.pitch] = float(yaw), float(pitch)
            outputs = self.poser.get_posing_outputs(tensor, params)
            assert tuple(outputs[self.coarse].shape) == (1, 2, 256, 256)
            assert tuple(outputs[self.fine].shape) == (1, 2, 512, 512)
            result = {name: outputs[idx][0].float().cpu().numpy().transpose(1, 2, 0).copy()
                      for name, idx in (("rotator", self.coarse), ("editor", self.fine), ("alpha", self.mask))}
            for name, idx in zip(("raw", "coarse_warp", "fine_warp"), (0, *self.warps)):
                result[name] = np.asarray(to_image(outputs[idx]).resize((256, 256), Image.Resampling.LANCZOS))
            return result


def load_samples(context, poses, cache, device, teacher=None):
    import torch
    metadata = json.dumps([SOURCE, torch.__version__, device, list(poses)], sort_keys=True)
    key = hashlib.sha256(context.tobytes() + metadata.encode()).hexdigest()[:20]
    cache.mkdir(parents=True, exist_ok=True)
    samples = []
    for index, pose in enumerate(poses):
        path = cache / f"{key}-{index}.npz"
        if not path.exists():
            if teacher is None:
                raise RuntimeError(f"Incomplete inference cache: {path}")
            result = teacher.run(context, *pose)
            # Only publish a complete archive. A failed writer can be retried.
            with tempfile.NamedTemporaryFile(dir=cache, suffix=".npz", delete=False) as f:
                tmp = Path(f.name)
            try:
                np.savez(tmp, **result, device=teacher.device)
                tmp.replace(path)
            finally:
                tmp.unlink(missing_ok=True)
        with np.load(path) as data:
            samples.append(dict(data))
    return samples


def collect_samples(root, device, contexts, poses, cache):
    import torch
    if device == "auto" and torch.backends.mps.is_available():
        # Some torch/macOS combinations terminate in native Metal code. Isolate GPU
        # inference so an abort cannot corrupt the rig or prevent the CPU retry.
        with tempfile.TemporaryDirectory() as scratch:
            names = {}
            for name, image in contexts.items():
                path = Path(scratch) / (name + ".png")
                image.save(path)
                names[name] = str(path)
            result = subprocess.run([sys.executable, __file__, str(root), str(cache), json.dumps(poses),
                                     json.dumps(names)])
        if result.returncode == 0:
            return {k: load_samples(im, poses, cache, "mps") for k, im in contexts.items()}
        print(f"MPS inference exited {result.returncode}, retrying on CPU.", file=sys.stderr)
    device = "cpu" if device == "auto" else device
    teacher = Teacher(root, device)
    return {k: load_samples(im, poses, cache, device, teacher) for k, im in contexts.items()}


if __name__ == "__main__":
    root, cache, poses, names = sys.argv[1:]
    teacher = Teacher(Path(root), "mps")
    for path in json.loads(names).values():
        with Image.open(path) as context:
            load_samples(context, json.loads(poses), Path(cache), "mps", teacher)
