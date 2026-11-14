#!/usr/bin/env python3
"""Prepare reviewed source assets only; never execute grammars or modify runtime pins."""

import argparse
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zlib


ASSET_DIR = Path(__file__).resolve().parents[1] / "runtime-data/omp-grammar-assets-v1"


def checked(data, pin, label):
    if len(data) != pin["size"] or hashlib.sha256(data).hexdigest() != pin["sha256"]:
        raise ValueError(f"size/SHA-256 mismatch: {label}")
    return data


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def source_bytes(pin, cache, offline):
    cached = cache / (pin["sha256"] + "-" + pin["file"])
    if cached.exists():
        return checked(cached.read_bytes(), pin, str(cached))
    if offline:
        raise FileNotFoundError(f"offline source missing: {cached.name}")
    with urllib.request.urlopen(pin["url"], timeout=60) as response:
        data = response.read(pin["size"] + 1)
    checked(data, pin, pin["url"])
    cached.write_bytes(data)
    return data


def prepare(sources, cache, offline):
    registry = source_bytes(sources["ompRegistry"], cache, offline).decode("utf-8")
    rows = re.findall(
        r'WasmGrammar::new\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",'
        r'\s*"([0-9a-f]{64})",\s*(\d+),\s*\)',
        registry,
    )
    grammars = sources["grammars"]
    expected_rows = [
        (g["language"], g["symbol"], g["file"], g["wasm"]["sha256"], str(g["wasm"]["size"]))
        for g in grammars
    ]
    if len(grammars) != 39 or sorted(rows) != sorted(expected_rows):
        raise ValueError("complete published OMP 18.20.0 grammar registry mismatch")

    publisher_files = {
        pin["file"]: source_bytes(pin, cache, offline) for pin in sources["publisherFiles"]
    }
    manifest = json.loads(publisher_files["manifest.json"])
    expected_manifest = [
        {**{key: g[key] for key in ("language", "crate", "version", "symbol", "file")}, **g["wasm"]}
        for g in grammars
    ]
    if (
        manifest["release"] != sources["publisherRelease"]["tag"]
        or manifest["tree_sitter"] != sources["publisherRelease"]["treeSitter"]
        or manifest["grammars"] != expected_manifest
    ):
        raise ValueError("complete publisher manifest mismatch")

    members = dict(publisher_files)
    for grammar in grammars:
        compressed = source_bytes(grammar["compressed"], cache, offline)
        wasm = subprocess.run(
            ["zstd", "--decompress", "--stdout", "--quiet"],
            input=compressed,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        ).stdout
        members[grammar["file"]] = checked(wasm, grammar["wasm"], grammar["file"])

    return members


def archive_bytes(members):
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(members.items()):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.REGTYPE
            entry.mode = 0o644
            entry.uid = entry.gid = entry.mtime = 0
            entry.uname = entry.gname = ""
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    tar_data = tar_buffer.getvalue()
    gzip_buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=gzip_buffer, mode="wb", filename="", mtime=0, compresslevel=9) as archive:
        archive.write(tar_data)
    return tar_data, gzip_buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, help="hash-prefixed source files; temporary by default")
    parser.add_argument("--offline", action="store_true", help="refuse any source download")
    parser.add_argument("--output-dir", type=Path, default=ASSET_DIR)
    args = parser.parse_args()
    sources_data = (ASSET_DIR / "sources.json").read_bytes()
    sources = json.loads(sources_data)
    required = sources["reproducer"]
    if sys.version.split()[0] != required["python"] or zlib.ZLIB_RUNTIME_VERSION != required["zlib"]:
        raise RuntimeError(f"exact archive reproduction requires Python {required['python']} and zlib {required['zlib']}")

    with contextlib.ExitStack() as stack:
        cache = args.cache_dir
        if cache is None:
            cache = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="omp-grammar-sources-")))
        cache.mkdir(parents=True, exist_ok=True)
        members = prepare(sources, cache, args.offline)
    tar_data, compressed = archive_bytes(members)
    stem = "grammars-v1"
    metadata = {
        "schemaVersion": 1,
        "archive": {
            "file": stem + ".tar.gz",
            "format": "tar.gz",
            "sha256": hashlib.sha256(compressed).hexdigest(),
            "maxBytes": len(compressed),
            "maxExpandedBytes": len(tar_data),
            "maxMembers": len(members),
            "expandedTarSha256": hashlib.sha256(tar_data).hexdigest(),
            "payloadBytes": sum(map(len, members.values())),
        },
        "sourceProvenanceSha256": hashlib.sha256(sources_data).hexdigest(),
        "grammarCount": len(sources["grammars"]),
        "aggregateCompressedZstBytes": sum(g["compressed"]["size"] for g in sources["grammars"]),
        "aggregateWasmBytes": sum(g["wasm"]["size"] for g in sources["grammars"]),
        "members": [
            {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(members.items())
        ],
    }
    checked(compressed, sources["archive"], "reviewed grammar archive")
    metadata_data = json_bytes(metadata)
    metadata_name = stem + ".json"
    # A reproducer must refuse drift before overwriting the reviewed source archive.
    reviewed = ASSET_DIR / metadata_name
    if reviewed.exists() and reviewed.read_bytes() != metadata_data:
        raise ValueError("reproduced archive metadata differs from the reviewed asset")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / (stem + ".tar.gz")).write_bytes(compressed)
    (args.output_dir / metadata_name).write_bytes(metadata_data)
    print(json.dumps(metadata["archive"], indent=2))


if __name__ == "__main__":
    main()
