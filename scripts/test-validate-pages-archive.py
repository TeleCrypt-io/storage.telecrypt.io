#!/usr/bin/env python3
"""Focused executable checks for the Pages archive trust boundary."""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = ROOT / "scripts" / "validate-pages-archive.py"
LIMITS = json.loads((ROOT / "scripts" / "pages-package-limits.json").read_text())


def member(name: str, data: bytes, mode: int = stat.S_IFREG | 0o644) -> tuple[zipfile.ZipInfo, bytes]:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = mode << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info, data


class ArchiveValidatorTest(unittest.TestCase):
    def run_validator(self, entries: list[tuple[zipfile.ZipInfo, bytes]]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "pages.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                for info, data in entries:
                    archive.writestr(info, data)
            return subprocess.run(
                [sys.executable, str(VALIDATOR), str(archive_path)],
                cwd=ROOT,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )

    @staticmethod
    def baseline() -> list[tuple[zipfile.ZipInfo, bytes]]:
        headers = (ROOT / "public" / "_headers").read_bytes()
        return [
            member("index.html", b"ok"),
            member("CNAME", b"storage.telecrypt.io\n"),
            member("_headers", headers),
        ]

    def test_accepts_a_small_canonical_archive(self) -> None:
        self.assertEqual(self.run_validator(self.baseline()).returncode, 0)

    def test_rejects_traversal_and_file_path_conflicts(self) -> None:
        for extra in [member("../escape", b"x"), member("assets", b"x"), member("assets/app.js", b"x")]:
            entries = self.baseline() + ([extra] if extra[0].filename.startswith("..") else [])
            if extra[0].filename == "assets":
                entries += [extra, member("assets/app.js", b"x")]
            if extra[0].filename == "assets/app.js":
                continue
            with self.subTest(extra=extra[0].filename):
                self.assertNotEqual(self.run_validator(entries).returncode, 0)

    def test_rejects_symlinks(self) -> None:
        result = self.run_validator(self.baseline() + [member("link", b"index.html", stat.S_IFLNK | 0o777)])
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_too_many_members(self) -> None:
        count = LIMITS["max_member_count"] - len(self.baseline()) + 1
        entries = self.baseline() + [member(f"assets/{index}", b"x") for index in range(count)]
        self.assertNotEqual(self.run_validator(entries).returncode, 0)

    def test_rejects_an_oversized_member(self) -> None:
        size = LIMITS["max_member_uncompressed_bytes"] + 1
        result = self.run_validator(self.baseline() + [member("assets/large", b"0" * size)])
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_an_oversized_member_name(self) -> None:
        name = "a" * (LIMITS["max_member_path_bytes"] + 1)
        result = self.run_validator(self.baseline() + [member(name, b"x")])
        self.assertNotEqual(result.returncode, 0)
        unicode_name = "é" * (LIMITS["max_member_path_bytes"] // 2 + 1)
        result = self.run_validator(self.baseline() + [member(unicode_name, b"x")])
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_excessive_total_expansion(self) -> None:
        half = LIMITS["max_total_uncompressed_bytes"] // 2 + 1
        entries = self.baseline() + [member("assets/a", b"0" * half), member("assets/b", b"0" * half)]
        self.assertNotEqual(self.run_validator(entries).returncode, 0)

    def test_rejects_wrong_cname(self) -> None:
        entries = self.baseline()
        entries[1] = member("CNAME", b"attacker.example\n")
        self.assertNotEqual(self.run_validator(entries).returncode, 0)

    def test_rejects_missing_headers(self) -> None:
        entries = [entry for entry in self.baseline() if entry[0].filename != "_headers"]
        self.assertNotEqual(self.run_validator(entries).returncode, 0)

    def test_rejects_wrong_headers(self) -> None:
        entries = self.baseline()
        entries[2] = member("_headers", b"/*\n  X-Frame-Options: DENY\n")
        self.assertNotEqual(self.run_validator(entries).returncode, 0)


if __name__ == "__main__":
    unittest.main(testRunner=unittest.TextTestRunner(stream=sys.stdout))
