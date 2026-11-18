#!/usr/bin/env python3
"""Download and measure an OMP release for review; never rewrite committed pins.

Requires Python 3 and GNU readelf on PATH. Downloaded executables are inspected,
never executed; npm package lifecycle scripts and provider APIs are not invoked.

Usage: python3 scripts/prepare-runtime-artifacts.py 18.22.2 --cache-dir /tmp/omp-runtime-18.22.2
The JSON report supplies both runtime graphs, which retain their own relativeTarget
names. Bun, CA, grammar assets and the dependency locks are independently owned.
"""

import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request


CHUNK = 1024 * 1024


def digest_file(path, algorithm="sha256"):
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK), b""):
            digest.update(chunk)
    return digest


def download(url, destination):
    if not destination.exists():
        temporary = destination.with_suffix(destination.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as source, temporary.open("wb") as output:
            while chunk := source.read(CHUNK):
                output.write(chunk)
        temporary.replace(destination)
    return destination


def json_url(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def elf(path):
    headers = subprocess.check_output(["readelf", "-lW", str(path)], text=True)
    dynamic = subprocess.check_output(["readelf", "-dW", str(path)], text=True)
    return {
        "interpreter": re.findall(r"Requesting program interpreter: ([^\]]+)", headers),
        "needed": sorted(re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic)),
    }


def archive(path, selected, output_dir):
    entries = {}
    count = 0
    with gzip.open(path, "rb") as expanded:
        with tarfile.open(fileobj=expanded, mode="r|") as source:
            for member in source:
                count += 1
                if member.name not in selected:
                    continue
                if not member.isfile():
                    raise ValueError(f"selected archive entry is not a file: {member.name}")
                target = output_dir / selected[member.name]
                digest = hashlib.sha256()
                with source.extractfile(member) as content, target.open("wb") as output:
                    while chunk := content.read(CHUNK):
                        digest.update(chunk)
                        output.write(chunk)
                entries[member.name] = {"sha256": digest.hexdigest(), "size": member.size}
        # Include tar headers, member padding and every trailing end/padding byte.
        while expanded.read(CHUNK):
            pass
        expanded_size = expanded.tell()
    if entries.keys() != selected.keys():
        raise ValueError(f"missing archive entries: {selected.keys() - entries.keys()}")
    return {
        "sha256": digest_file(path).hexdigest(),
        "maxBytes": path.stat().st_size,
        "maxExpandedBytes": expanded_size,
        "maxMembers": count,
        "entries": entries,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("version must be an exact numeric release")
    cache = args.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    release_url = f"https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v{args.version}"
    release = json_url(release_url)
    assets = {asset["name"]: asset for asset in release["assets"]}
    report = {"version": args.version, "release": release_url, "releaseAssets": {}, "npm": {}}
    for name in ("omp-linux-x64", "omp-linux-arm64", "omp-linux-musl-x64", "omp-linux-musl-arm64", "LICENSE"):
        asset = assets[name]
        path = download(asset["browser_download_url"], cache / name)
        digest = digest_file(path).hexdigest()
        size = path.stat().st_size
        if size != asset["size"] or asset["digest"] != "sha256:" + digest:
            raise ValueError(f"GitHub release size/digest mismatch: {name}")
        report["releaseAssets"][name] = {"url": asset["browser_download_url"], "sha256": digest, "size": size}
        if name != "LICENSE":
            report["releaseAssets"][name].update(elf(path))
    for package in ("pi-natives-linux-x64", "pi-natives-linux-arm64", "pi-natives", "pi-coding-agent"):
        metadata = json_url(f"https://registry.npmjs.org/@oh-my-pi/{package}/{args.version}")
        if metadata["version"] != args.version:
            raise ValueError(f"registry version mismatch: {package}")
        dist = metadata["dist"]
        path = download(dist["tarball"], cache / f"{package}-{args.version}.tgz")
        integrity = "sha512-" + base64.b64encode(digest_file(path, "sha512").digest()).decode("ascii")
        if integrity != dist["integrity"]:
            raise ValueError(f"registry SHA-512 mismatch: {package}")
        if package.startswith("pi-natives-linux-"):
            native = "pi_natives.linux-x64-baseline.node" if package.endswith("x64") else "pi_natives.linux-arm64.node"
            selected = {"package/" + name: package + "-" + name for name in (native, "LICENSE", "THIRD-PARTY-NOTICES.txt")}
        elif package == "pi-natives":
            selected = {"package/native/loader-state.js": "pi-natives-loader-state.js"}
        else:
            selected = {"package/THIRD-PARTY-NOTICES.txt": "pi-coding-agent-THIRD-PARTY-NOTICES.txt"}
        measured = archive(path, selected, cache)
        measured.update({"url": dist["tarball"], "integrity": integrity})
        if package.startswith("pi-natives-linux-"):
            measured["elf"] = elf(cache / selected["package/" + native])
        report["npm"][package] = measured
    report["releaseAssetNames"] = sorted(assets)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
