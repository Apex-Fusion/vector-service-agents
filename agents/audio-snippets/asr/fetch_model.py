"""Fetch the faster-whisper model of Audio Snippets into a directory, at a pinned revision, and check it.

python3 -I fetch_model.py SIZE DEST
Run by the Dockerfile at build time, and once on a developer's machine: the service itself never fetches anything.
"""
import hashlib
import os
import sys

# Systran/faster-whisper-<size> on the Hugging Face hub: the commit of the files, and the sha256 and size of model.bin, read from the hub on 2026-10-16.
PINS = {
    "base": ("ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66", "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9", 145217532),
    "small": ("536b0662742c02347bc0e980a01041f333bce120", "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671", 483546902),
}
FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv):
    if len(argv) != 2 or argv[0] not in PINS:
        print("usage: fetch_model.py " + "|".join(sorted(PINS)) + " DEST", file=sys.stderr)
        return 2
    size, dest = argv
    revision, model_sha256, model_bytes = PINS[size]
    from huggingface_hub import snapshot_download

    snapshot_download("Systran/faster-whisper-" + size, revision=revision, local_dir=dest, allow_patterns=FILES)
    missing = [name for name in FILES if not os.path.isfile(os.path.join(dest, name))]
    if missing:
        print("missing after the download: " + ", ".join(missing), file=sys.stderr)
        return 1
    model = os.path.join(dest, "model.bin")
    if os.path.getsize(model) != model_bytes or sha256_of(model) != model_sha256:
        print("model.bin is not the pinned file: its size or its sha256 differs", file=sys.stderr)
        return 1
    print("fetched faster-whisper-" + size + " at " + revision + " into " + dest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
