"""Build and validate a reproducible unpacked-extension ZIP from tracked files."""

from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[2]
output = root / "dist" / "flawless-extension.zip"
output.parent.mkdir(exist_ok=True)

directories = ("artwork/", "auth/", "css/", "icons/", "js/", "native/", "vendor/")
root_files = {
    "manifest.json", "LICENSE", "README.md",
    "link-preview.html", "options.html", "popup.html", "publisher-setup.html",
}
tracked = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"]).decode().split("\0")
members = sorted(
    name for name in tracked
    if name and (name in root_files or name.startswith(directories))
)
assert "manifest.json" in members, "Cannot package an extension without a manifest"

with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for name in members:
        path = root / name
        assert path.is_file(), f"Missing tracked extension file: {name}"
        archive.write(path, arcname=name)

with ZipFile(output) as archive:
    assert archive.testzip() is None, "Archive CRC validation failed"
    assert sorted(archive.namelist()) == members, "Packaged file list changed"
    assert "manifest.json" in archive.namelist()

print(f"Validated {output}: {len(members)} tracked extension files")
