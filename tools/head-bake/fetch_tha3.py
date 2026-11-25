"""Fetch Pramook Khungurn's MIT demo and CC BY 4.0 separable_float weights."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile

SOURCE = "8946939ec7b417f443d7b0e3fcd97384313fcdb8"
REVISION = "a538612b602a019e8c59c8d08e89727a3c34525b"
CACHE = Path.home() / ".cache/koma-rig/tha3"
WEIGHTS = {
    "editor": "ecbc46808aeed3088a215d3884d0b162d76337211d73a9bb21cdd92fc45fc50b",
    "eyebrow_decomposer": "1fbf5015083876653d64885481cc7b7145df0321101648b2692696042f97b799",
    "eyebrow_morphing_combiner": "de9cacc5d47e65e9c5b4b6317c0e86a31a27a5d01378edff3010a10f6deab106",
    "face_morpher": "e6977e73e3fcfc7614e37592f255d67d0eeba0cd86e7e700ecacffd7a4e53818",
    "two_algo_face_body_rotator": "79d2609cdac8fc61335c3f3045dc20094324bd5854d6427b21d4c388928282cf",
}
SIZES = {"editor": 3802999, "eyebrow_decomposer": 13313007, "eyebrow_morphing_combiner": 13334119,
         "face_morpher": 13374071, "two_algo_face_body_rotator": 14355239}


def download(url, target, size, chunked):
    options = ["curl", "-fsSL", "--retry", "4", "--retry-all-errors", "--connect-timeout", "20",
               "--speed-time", "90", "--speed-limit", "128"]
    if not chunked:
        subprocess.run([*options, url, "-o", target], check=True)
        return
    chunk_size = 1024 * 1024
    with target.open("wb") as out:
        for start in range(0, size, chunk_size):
            end = min(size, start + chunk_size) - 1
            part = subprocess.check_output([*options, "--range", f"{start}-{end}", f"{url}?chunk={start}"])
            if start == 0 and len(part) == size:  # The host served the complete object.
                out.write(part)
                return
            if len(part) != end - start + 1:
                raise ValueError(f"Unexpected range response for bytes {start}–{end}")
            out.write(part)


def fetch(root, host, chunked=False):
    root.mkdir(parents=True, exist_ok=True)
    source = root / "source"
    if not source.exists():
        with tempfile.TemporaryDirectory(dir=root) as scratch:
            checkout = Path(scratch) / "source"
            subprocess.run(["git", "clone", "--quiet", "--no-checkout",
                            "https://github.com/pkhungurn/talking-head-anime-3-demo.git", checkout], check=True)
            subprocess.run(["git", "-C", checkout, "checkout", "--quiet", "--detach", SOURCE], check=True)
            checkout.rename(source)
    if subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], text=True).strip() != SOURCE:
        raise ValueError(f"Unexpected THA3 revision in {source}")
    folder = root / "separable_float"
    folder.mkdir(exist_ok=True)
    for name, digest in WEIGHTS.items():
        target = folder / (name + ".pt")
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
            continue
        url = f"{host.rstrip('/')}/ksuriuri/talking-head-anime-3-models/resolve/{REVISION}/separable_float/{name}.pt"
        with tempfile.TemporaryDirectory(dir=folder) as scratch:
            tmp = Path(scratch) / target.name
            download(url, tmp, SIZES[name], chunked)
            if hashlib.sha256(tmp.read_bytes()).hexdigest() != digest:
                raise ValueError(f"SHA-256 mismatch for {name}")
            tmp.replace(target)
        print(name, "verified", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights-dir", type=Path, default=CACHE)
    parser.add_argument("--host", default="https://huggingface.co")
    parser.add_argument("--chunked", action="store_true", help="fetch weights in 1 MiB HTTP ranges")
    args = parser.parse_args()
    fetch(args.weights_dir, args.host, args.chunked)
