#!/usr/bin/env python3
"""Reject unsafe Pages ZIP members before extraction."""

import stat
import json
import sys
import zipfile
from pathlib import Path
from pathlib import PurePosixPath


LIMITS = json.loads((Path(__file__).with_name("pages-package-limits.json")).read_text())
if set(LIMITS) != {
    "max_archive_bytes",
    "max_member_count",
    "max_member_path_bytes",
    "max_member_uncompressed_bytes",
    "max_total_uncompressed_bytes",
} or any(type(value) is not int or value <= 0 for value in LIMITS.values()):
    raise SystemExit("Pages package limits are invalid")
MAX_ARCHIVE_BYTES = LIMITS["max_archive_bytes"]
MAX_MEMBER_COUNT = LIMITS["max_member_count"]
MAX_MEMBER_PATH_BYTES = LIMITS["max_member_path_bytes"]
MAX_MEMBER_UNCOMPRESSED_BYTES = LIMITS["max_member_uncompressed_bytes"]
MAX_TOTAL_UNCOMPRESSED_BYTES = LIMITS["max_total_uncompressed_bytes"]


def fail(message: str) -> None:
    raise SystemExit(message)


if len(sys.argv) != 2:
    fail("usage: validate-pages-archive.py ARCHIVE")

archive_path = sys.argv[1]
archive_size = Path(archive_path).stat().st_size
if archive_size <= 0 or archive_size > MAX_ARCHIVE_BYTES:
    fail("archive exceeds the compressed size limit")
with zipfile.ZipFile(archive_path) as archive:
    members = archive.infolist()
    if len(members) == 0 or len(members) > MAX_MEMBER_COUNT:
        fail("archive contains too many members")
    names = []
    total_uncompressed = 0
    for member in members:
        name = member.filename
        if len(name.encode("utf-8", "surrogateescape")) > MAX_MEMBER_PATH_BYTES:
            fail("archive member name exceeds the byte limit")
        if not name or any(ord(character) < 0x20 or ord(character) == 0x7F for character in name):
            fail("archive contains an abnormal member name")
        if "\\" in name or name.startswith("/"):
            fail("archive contains an absolute or backslash member name")
        path = PurePosixPath(name)
        if any(part in ("", ".", "..") for part in path.parts):
            fail("archive contains a non-canonical member path")
        if path.as_posix() != name or name.endswith("/"):
            fail("archive contains a directory or non-canonical member")
        mode = (member.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode) or (mode and not stat.S_ISREG(mode)):
            fail("archive contains a non-regular member")
        if member.file_size > MAX_MEMBER_UNCOMPRESSED_BYTES:
            fail("archive member exceeds the uncompressed size limit")
        total_uncompressed += member.file_size
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES:
            fail("archive exceeds the total uncompressed size limit")
        names.append(name)

    if len(names) != len(set(names)):
        fail("archive contains duplicate member names")
    name_set = set(names)
    for name in names:
        parts = PurePosixPath(name).parts
        for index in range(1, len(parts)):
            if "/".join(parts[:index]) in name_set:
                fail("archive contains a file/path conflict")
    if name_set != {"index.html", "CNAME"} and not {"index.html", "CNAME"}.issubset(name_set):
        fail("archive is missing the required Pages files")
    cname = archive.read("CNAME")
    if cname != b"storage.telecrypt.io\n":
        fail("archive has an unexpected CNAME")
