"""Verify downloaded wheels against PyPI and record the Windows CPython 3.14 lock/licenses."""

import hashlib
import json
import pathlib
import sys
import urllib.request
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
assets = root / "src/domains/data"
wheels = pathlib.Path(sys.argv[1]).resolve()
packages = []
for line in (assets / "requirements.txt").read_text(encoding="utf-8").splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    name, version = line.split("==")
    with urllib.request.urlopen(
        f"https://pypi.org/pypi/{name}/{version}/json", timeout=30
    ) as response:
        metadata = json.load(response)
    candidates = [file for file in metadata["urls"] if (wheels / file["filename"]).is_file()]
    if len(candidates) != 1:
        raise RuntimeError(f"Expected exactly one downloaded wheel for {name}")
    file = candidates[0]
    path = wheels / file["filename"]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != file["digests"]["sha256"]:
        raise RuntimeError(f"PyPI hash mismatch for {name}")
    packages.append(dict(name=name, version=version, wheel=path.name, sha256=digest))
    with zipfile.ZipFile(path) as archive:
        licenses = [
            entry
            for entry in archive.namelist()
            if ".dist-info/" in entry
            and not entry.endswith("/")
            and (
                "/licenses/" in entry.lower()
                or pathlib.PurePosixPath(entry)
                .name.lower()
                .startswith(("license", "licence", "copying", "notice"))
            )
        ]
        if not licenses:
            raise RuntimeError(f"Wheel has no license: {name}")
        for index, entry in enumerate(licenses):
            target = assets / "licenses" / name / f"{index}-{pathlib.PurePosixPath(entry).name}"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
lock = dict(version=1, python="3.14", platform="win32", arch="x64", packages=packages)
(assets / "runtime-lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
(assets / "requirements-win32-py314.txt").write_text(
    "# Windows x64 / CPython 3.14; verified against PyPI JSON metadata.\n"
    + "".join(f"{p['name']}=={p['version']} --hash=sha256:{p['sha256']}\n" for p in packages),
    encoding="utf-8",
)
print(json.dumps(dict(packages=len(packages), verified=True)))
