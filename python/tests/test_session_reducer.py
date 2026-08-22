import json
import unittest
from pathlib import Path

from tiny_agent.session_reducer import SessionCorruption, reduce_session

FIXTURES = Path(__file__).resolve().parents[2] / "schemas/session/fixtures"


class SessionTest(unittest.TestCase):
    def test_all_shared_fixtures(self):
        manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
        for fixture in manifest["fixtures"]:
            with self.subTest(fixture=fixture["name"]):
                expected = json.loads((FIXTURES / fixture["expected"]).read_text(encoding="utf-8"))
                try:
                    actual = {"ok": True, "state": reduce_session((FIXTURES / fixture["file"]).read_bytes())}
                except SessionCorruption as error:
                    details = {"code": error.code, "line": error.line}
                    if error.seq is not None:
                        details["seq"] = error.seq
                    actual = {"ok": False, "error": details}
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
