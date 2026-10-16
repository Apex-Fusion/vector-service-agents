"""Fetch the faster-whisper model of Audio Snippets into a directory, at a pinned revision, and check it.

python3 -I fetch_model.py SIZE DEST
Run by the Dockerfile at build time, and once on a developer's machine: the service itself never fetches anything. A directory that already holds the four
files as pinned is left as it is, and nothing is fetched; after a fetch, each of the four is held to its pinned size and sha256.
"""
import hashlib
import os
import sys

# Systran/faster-whisper-<size> on the Hugging Face hub: the commit of the files, and the size and sha256 of each, read on 2026-10-16. model.bin: from the
# hub's record of the file. The three small files of base: from the files fetched at that commit, whose git blob ids are the hub's. small shares
# tokenizer.json and vocabulary.txt with base (the same git blob ids); its config.json was never fetched here, so it is held to its size alone (None).
PINS = {
    "base": ("ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66", {
        "config.json": (2309, "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a"),
        "model.bin": (145217532, "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"),
        "tokenizer.json": (2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
        "vocabulary.txt": (459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
    }),
    "small": ("536b0662742c02347bc0e980a01041f333bce120", {
        "config.json": (2370, None),
        "model.bin": (483546902, "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"),
        "tokenizer.json": (2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
        "vocabulary.txt": (459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
    }),
}


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def wrong_files(dest, files):
    """The files that are not in dest as pinned: missing, of another size, or of another sha256 where one is pinned."""
    wrong = []
    for name in sorted(files):
        size, digest = files[name]
        path = os.path.join(dest, name)
        if not os.path.isfile(path) or os.path.getsize(path) != size or (digest is not None and sha256_of(path) != digest):
            wrong.append(name)
    return wrong


def main(argv):
    if len(argv) != 2 or argv[0] not in PINS:
        print("usage: fetch_model.py " + "|".join(sorted(PINS)) + " DEST", file=sys.stderr)
        return 2
    size, dest = argv
    revision, files = PINS[size]
    if not wrong_files(dest, files):
        print("faster-whisper-" + size + " at " + revision + " is already in " + dest)
        return 0
    from huggingface_hub import snapshot_download

    snapshot_download("Systran/faster-whisper-" + size, revision=revision, local_dir=dest, allow_patterns=sorted(files))
    wrong = wrong_files(dest, files)
    if wrong:
        print("not the pinned files after the download (missing, or of another size or sha256): " + ", ".join(wrong), file=sys.stderr)
        return 1
    print("fetched faster-whisper-" + size + " at " + revision + " into " + dest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
