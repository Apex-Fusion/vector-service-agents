"""The speech recognition of Audio Snippets: one job, one process.

Read one JSON request on stdin, run faster-whisper on the WAV it names, write one JSON answer on stdout, and exit.
The service starts it as `python3 -I worker.py` (isolated mode: no PYTHON* variable, no user site, no folder of the script on the path).

Request: {"wav": path, "language": code or null, "model_dir": path, "threads": int, "compute_type": "int8"}
Answer, exit 0: {"ok": true, "language": code, "language_probability": float, "duration": float, "segments": [...]}
Answer, exit 2, 3 or 4: {"ok": false, "error": "bad_request" | "model_load_failed" | "transcribe_failed", "message": text}

`python3 -I worker.py --check MODEL_DIR` imports faster-whisper, looks for the model files and prints the versions, for the start of the service.
Everything it prints is ASCII (json.dumps escapes the rest), so the code page of a console cannot change it. Python 3.9 or later.
"""
import json
import os
import sys

MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
REQUEST_KEYS = ("wav", "language", "model_dir", "threads", "compute_type")


def answer(stream, payload):
    stream.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    stream.flush()


def failure(stream, code, error, status):
    answer(stream, {"ok": False, "error": code, "message": str(error)[:300]})
    return status


def check_request(request):
    if not isinstance(request, dict) or sorted(request) != sorted(REQUEST_KEYS):
        raise ValueError("the request must have exactly the keys " + ", ".join(REQUEST_KEYS))
    if not isinstance(request["wav"], str) or not isinstance(request["model_dir"], str):
        raise ValueError("wav and model_dir must be paths")
    if request["language"] is not None and not isinstance(request["language"], str):
        raise ValueError("language must be a code or null")
    threads = request["threads"]
    if isinstance(threads, bool) or not isinstance(threads, int) or not 1 <= threads <= 64:
        raise ValueError("threads must be a whole number from 1 to 64")
    if request["compute_type"] != "int8":
        raise ValueError("compute_type must be int8")


def missing_files(model_dir):
    """The files of the model that are not in model_dir: all of them when it is no directory."""
    if not os.path.isdir(model_dir):
        return list(MODEL_FILES)
    return [name for name in MODEL_FILES if not os.path.isfile(os.path.join(model_dir, name))]


def load_model(model_dir, threads, compute_type):
    # faster-whisper is asked for a model only in a directory that holds its four files (ruled 2026-10-16; R-D2: nothing is fetched while a job runs). It
    # would take a model_dir that is no directory for the name of a model on the hub and fetch it, and it fetches a tokenizer from the hub when
    # tokenizer.json is missing; a refusal here is model_load_failed, naming the missing files. local_files_only stays as a second guard.
    missing = missing_files(model_dir)
    if missing:
        raise RuntimeError("the model directory lacks " + ", ".join(missing))
    from faster_whisper import WhisperModel  # imported here, so that the contract test runs without it

    return WhisperModel(model_dir, device="cpu", compute_type=compute_type, cpu_threads=threads, local_files_only=True)


def transcribe(model, request):
    segments, info = model.transcribe(
        request["wav"],
        language=request["language"],
        task="transcribe",
        beam_size=5,
        temperature=0.0,
        condition_on_previous_text=False,
        word_timestamps=True,
        vad_filter=False,
    )
    out = []
    for segment in segments:  # a generator: the decoding happens while it is read
        words = []
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append({"w": text, "start": float(word.start), "end": float(word.end)})
        out.append({"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip(), "words": words})
    return {
        "ok": True,
        "language": info.language,
        "language_probability": float(info.language_probability),
        "duration": float(info.duration),
        "segments": out,
    }


def check(model_dir, stdout):
    import ctranslate2
    import faster_whisper

    missing = missing_files(model_dir)
    if missing:
        answer(stdout, {"ok": False, "error": "model_missing", "message": "the model directory lacks " + ", ".join(missing)})
        return 1
    answer(stdout, {"ok": True, "faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__})
    return 0


def main(argv, stdin, stdout, loader=load_model):
    if len(argv) == 2 and argv[0] == "--check":
        return check(argv[1], stdout)
    if argv:
        return failure(stdout, "bad_request", "usage: worker.py, or worker.py --check MODEL_DIR", 2)
    try:
        request = json.loads(stdin.read().decode("utf-8"))
        check_request(request)
    except (ValueError, UnicodeDecodeError) as error:
        return failure(stdout, "bad_request", error, 2)
    try:
        model = loader(request["model_dir"], request["threads"], request["compute_type"])
    except Exception as error:  # noqa: BLE001 - a failure to load is reported, never raised
        return failure(stdout, "model_load_failed", error, 3)
    try:
        result = transcribe(model, request)
    except Exception as error:  # noqa: BLE001
        return failure(stdout, "transcribe_failed", error, 4)
    answer(stdout, result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], sys.stdin.buffer, sys.stdout))
