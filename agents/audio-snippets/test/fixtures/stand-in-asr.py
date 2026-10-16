"""A stand-in for asr/worker.py in the test of the service as a process (test/start.test.ts): the same contract, and no model.

--check answers the versions the requirements pin; a job answers an empty transcript, in the language it was asked for, or en when it was asked to detect it.
Python 3.9 or later.
"""
import json
import sys

if sys.argv[1:2] == ["--check"]:
    sys.stdout.write(json.dumps({"ok": True, "faster_whisper": "1.2.1", "ctranslate2": "4.8.2"}))
    sys.exit(0)
request = json.loads(sys.stdin.read())
sys.stdout.write(json.dumps({"ok": True, "language": request["language"] or "en", "language_probability": 1.0, "duration": 0.0, "segments": []}))
