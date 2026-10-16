"""The JSON contract of worker.py, with a model that is a stub: no faster-whisper, no model files.

Run: python3 -I test_worker.py  (test/worker-contract.test.ts runs it so)
"""
import io
import json
import os
import socket
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the folder of the script off the path

import worker  # noqa: E402


class Word:
    def __init__(self, word, start, end):
        self.word, self.start, self.end, self.probability = word, start, end, 0.9


class Segment:
    def __init__(self, start, end, text, words):
        self.start, self.end, self.text, self.words = start, end, text, words


class Info:
    language = "en"
    language_probability = 0.98
    duration = 3.0


class StubModel:
    def __init__(self, segments=None, error=None):
        self.calls = []
        self.segments = segments
        self.error = error

    def transcribe(self, audio, **options):
        self.calls.append((audio, options))
        if self.error is not None:
            raise self.error
        return iter(self.segments), Info()


REQUEST = {"wav": "/tmp/job/audio.wav", "language": "en", "model_dir": "/app/asr/models/base", "threads": 4, "compute_type": "int8"}
SEGMENTS = [
    Segment(0.0, 1.2, " This is a LibriVox recording.", [Word(" This", 0.1, 0.25), Word(" is", 0.25, 0.35), Word(" ", 0.35, 0.36), Word(" a", 0.36, 0.4)]),
    Segment(1.4, 2.95, " All of it.", None),
]


def run(request, loader):
    stdout = io.StringIO()
    raw = request if isinstance(request, bytes) else json.dumps(request).encode("utf-8")
    status = worker.main([], io.BytesIO(raw), stdout, loader=loader)
    return status, json.loads(stdout.getvalue())


def without_network(action):
    """Runs action() with every connection refused and counted and, when the hub client is installed, its cache an empty folder and its offline switch off.

    Answers what action() answered, the connections it tried and the seconds it took.
    """
    try:
        from huggingface_hub import constants
    except ImportError:
        constants = None
    attempts = []

    def refuse(*args, **kwargs):
        attempts.append(args[:1])
        raise OSError("this test reaches no network")

    saved = (socket.create_connection, socket.getaddrinfo)
    saved_hub = (constants.HF_HUB_CACHE, constants.HF_HUB_OFFLINE) if constants is not None else None
    with tempfile.TemporaryDirectory() as empty:
        socket.create_connection, socket.getaddrinfo = refuse, refuse
        if constants is not None:
            constants.HF_HUB_CACHE, constants.HF_HUB_OFFLINE = empty, False
        try:
            began = time.monotonic()
            result = action()
            took = time.monotonic() - began
        finally:
            socket.create_connection, socket.getaddrinfo = saved
            if constants is not None:
                constants.HF_HUB_CACHE, constants.HF_HUB_OFFLINE = saved_hub
    return result, attempts, took


class Contract(unittest.TestCase):
    def test_a_job_answers_the_segments_and_the_words_stripped_with_the_language_and_exits_0(self):
        model = StubModel(SEGMENTS)
        loaded = []
        status, out = run(REQUEST, lambda d, t, c: loaded.append((d, t, c)) or model)
        self.assertEqual(status, 0)
        self.assertEqual(loaded, [("/app/asr/models/base", 4, "int8")])
        self.assertEqual(out, {
            "ok": True, "language": "en", "language_probability": 0.98, "duration": 3.0,
            "segments": [
                {"start": 0.0, "end": 1.2, "text": "This is a LibriVox recording.", "words": [
                    {"w": "This", "start": 0.1, "end": 0.25}, {"w": "is", "start": 0.25, "end": 0.35}, {"w": "a", "start": 0.36, "end": 0.4}]},
                {"start": 1.4, "end": 2.95, "text": "All of it.", "words": []},
            ],
        })

    def test_the_model_is_asked_with_the_fixed_options_and_the_language_as_given(self):
        model = StubModel(SEGMENTS)
        run(dict(REQUEST, language=None), lambda d, t, c: model)
        audio, options = model.calls[0]
        self.assertEqual(audio, "/tmp/job/audio.wav")
        self.assertEqual(options, {"language": None, "task": "transcribe", "beam_size": 5, "temperature": 0.0, "condition_on_previous_text": False, "word_timestamps": True, "vad_filter": False})

    def test_a_request_that_is_not_the_contract_is_bad_request_exit_2(self):
        bad = [b"not json", b"\xff\xfe", json.dumps(dict(REQUEST, extra=1)).encode(), json.dumps(dict(REQUEST, threads=0)).encode(),
               json.dumps(dict(REQUEST, threads=True)).encode(), json.dumps(dict(REQUEST, compute_type="float32")).encode(), json.dumps(dict(REQUEST, language=7)).encode(),
               json.dumps({k: v for k, v in REQUEST.items() if k != "wav"}).encode()]
        for raw in bad:
            status, out = run(raw, lambda d, t, c: StubModel(SEGMENTS))
            self.assertEqual(status, 2, raw)
            self.assertEqual((out["ok"], out["error"]), (False, "bad_request"), raw)

    def test_a_model_that_cannot_load_is_model_load_failed_exit_3_and_a_failed_decode_is_transcribe_failed_exit_4(self):
        def broken(d, t, c):
            raise RuntimeError("no model.bin in " + d)
        status, out = run(REQUEST, broken)
        self.assertEqual((status, out["error"]), (3, "model_load_failed"))
        self.assertIn("no model.bin", out["message"])
        status, out = run(REQUEST, lambda d, t, c: StubModel(error=ValueError("x" * 1000)))
        self.assertEqual((status, out["error"], len(out["message"])), (4, "transcribe_failed", 300))

    def test_what_it_prints_is_ascii_whatever_the_text(self):
        model = StubModel([Segment(0.0, 1.0, " Qu\u00e9 \u2014 caf\u00e9", [Word(" Qu\u00e9", 0.0, 0.5)])])
        stdout = io.StringIO()
        worker.main([], io.BytesIO(json.dumps(REQUEST).encode()), stdout, loader=lambda d, t, c: model)
        text = stdout.getvalue()
        self.assertTrue(all(ord(ch) < 128 for ch in text))
        self.assertEqual(json.loads(text)["segments"][0]["text"], "Qu\u00e9 \u2014 caf\u00e9")

    def test_what_the_model_prints_while_it_loads_and_decodes_goes_to_stderr_and_stdout_carries_the_answer_alone(self):
        class Noisy(StubModel):
            def transcribe(self, audio, **options):
                print("decoding")
                return StubModel.transcribe(self, audio, **options)

        def loader(d, t, c):
            print("loading")
            return Noisy(SEGMENTS)

        def broken(d, t, c):
            print("loading")
            raise RuntimeError("no model.bin")

        for load, status_wanted, said in ((loader, 0, "loading\ndecoding\n"), (broken, 3, "loading\n")):
            saved_out, saved_err = sys.stdout, sys.stderr
            out, err = io.StringIO(), io.StringIO()
            sys.stdout, sys.stderr = out, err
            try:
                # As the service runs it: the answer goes to the stream that is sys.stdout.
                status = worker.main([], io.BytesIO(json.dumps(REQUEST).encode()), out, loader=load)
                restored = sys.stdout
            finally:
                sys.stdout, sys.stderr = saved_out, saved_err
            self.assertEqual(status, status_wanted)
            self.assertEqual(json.loads(out.getvalue())["ok"], status_wanted == 0)
            self.assertIs(restored, out)
            self.assertEqual(err.getvalue(), said)

    def test_arguments_other_than_check_are_refused(self):
        stdout = io.StringIO()
        self.assertEqual(worker.main(["--other"], io.BytesIO(b""), stdout), 2)
        self.assertEqual(json.loads(stdout.getvalue())["error"], "bad_request")

    def test_check_names_the_model_files_that_are_missing(self):
        stdout = io.StringIO()
        here = os.path.dirname(os.path.abspath(__file__))
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            self.skipTest("faster-whisper is not installed here; the check is run for real by test/asr-real.test.ts")
        self.assertEqual(worker.main(["--check", here], io.BytesIO(b""), stdout), 1)
        out = json.loads(stdout.getvalue())
        self.assertEqual((out["ok"], out["error"]), (False, "model_missing"))
        self.assertIn("model.bin", out["message"])

    def test_a_model_dir_that_is_no_directory_is_model_load_failed_and_nothing_is_fetched(self):
        # Ruled 2026-10-16 (R-D2: nothing is fetched while a job runs). faster-whisper takes a model_dir that is no directory for the name of a model on the
        # hub ("base" is Systran/faster-whisper-base, 148 MB); the worker refuses it before faster-whisper is asked, with every connection refused and counted.
        self.assertFalse(os.path.isdir("base"))
        (status, out), attempts, took = without_network(lambda: run(dict(REQUEST, model_dir="base"), worker.load_model))
        self.assertEqual(attempts, [])
        self.assertEqual((status, out["ok"], out["error"]), (3, False, "model_load_failed"))
        self.assertIn("model.bin", out["message"])
        self.assertLess(took, 5)

    def test_a_model_dir_without_all_four_files_is_model_load_failed_naming_the_missing_ones_and_nothing_is_fetched(self):
        # faster-whisper fetches a tokenizer from the hub when tokenizer.json is missing, in code that no socket patch here can see: the worker asks it for
        # a model only when the directory holds model.bin, config.json, tokenizer.json and vocabulary.txt.
        with tempfile.TemporaryDirectory() as folder:
            open(os.path.join(folder, "model.bin"), "wb").close()
            (status, out), attempts, took = without_network(lambda: run(dict(REQUEST, model_dir=folder), worker.load_model))
        self.assertEqual(attempts, [])
        self.assertEqual((status, out["error"], out["message"]), (3, "model_load_failed", "the model directory lacks config.json, tokenizer.json, vocabulary.txt"))
        self.assertLess(took, 5)

if __name__ == "__main__":
    unittest.main()
