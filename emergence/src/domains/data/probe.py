"""Read-only runtime verification; never imports project modules or prints environment variables."""
import importlib
import importlib.metadata
import json
import pathlib
import struct
import sys

lock = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if f'{sys.version_info.major}.{sys.version_info.minor}' != lock['python']:
    raise RuntimeError(f"Requires Python {lock['python']}")
if sys.platform != lock['platform'] or struct.calcsize('P') != 8:
    raise RuntimeError('Requires Windows x64')
versions = {}
for package in lock['packages']:
    version = importlib.metadata.version(package['name'])
    if version != package['version']:
        raise RuntimeError('Dependency version mismatch: ' + package['name'])
    importlib.import_module(package['name'].replace('-', '_'))
    versions[package['name']] = version
print(json.dumps(dict(python=sys.version.split()[0], packages=versions)))
