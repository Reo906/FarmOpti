from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from chatbot.scenario.validator import ScenarioValidator


class ScenarioValidatorTests(unittest.TestCase):
    def test_appledouble_csv_files_are_not_loaded_as_farm_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "management_plan.csv").write_text(
                "plan_id,field_id,operation,amount\nP1,F1,harvest,1\n",
                encoding="utf-8",
            )
            (path / "._management_plan.csv").write_bytes(b"\x00\x05metadata")
            validator = ScenarioValidator(path)
            self.assertEqual(list(validator.tables), ["management_plan"])
