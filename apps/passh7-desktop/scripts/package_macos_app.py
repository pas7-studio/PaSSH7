#!/usr/bin/env python3
"""Package a cross-compiled Darwin Mach-O as an EXPERIMENTAL unsigned .app zip.

This is NOT the official Tauri macOS bundler. Run actual WebKit/SSH/Vault tests
on a Mac before distributing. The source SDK is not copied into this artifact.
"""
import argparse
import os
import pathlib
import plistlib
import shutil
import struct
import subprocess
import sys
import zipfile

ARCHES = {"aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x64"}


def write_icns(png: bytes, dest: pathlib.Path) -> None:
    # icp6 = 64x64 PNG icon; generated project icon is already 64x64.
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Generated icon is not a PNG")
    width, height = struct.unpack(">II", png[16:24])
    if (width, height) != (64, 64):
        raise ValueError("Expected the 64x64 project icon")
    block = b"icp6" + struct.pack(">I", len(png) + 8) + png
    dest.write_bytes(b"icns" + struct.pack(">I", len(block) + 8) + block)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--target", choices=tuple(ARCHES), required=True)
    p.add_argument("--binary", type=pathlib.Path, required=True)
    p.add_argument("--icon", type=pathlib.Path, required=True)
    p.add_argument("--output", type=pathlib.Path, required=True)
    p.add_argument("--version", default="0.2.0")
    args = p.parse_args()

    binary = args.binary.resolve()
    if not binary.is_file() or binary.stat().st_size < 100_000:
        raise RuntimeError(f"Missing or unexpectedly small Darwin binary: {binary}")
    detected = subprocess.check_output(["file", "-b", str(binary)], text=True)
    expected = "arm64" if args.target.startswith("aarch64") else "x86_64"
    if "Mach-O" not in detected or expected not in detected:
        raise RuntimeError(f"Wrong binary format for {args.target}: {detected.strip()}")

    args.output.mkdir(parents=True, exist_ok=True)
    app = args.output / "PaSSH7.app"
    if app.exists():
        shutil.rmtree(app)
    macos = app / "Contents" / "MacOS"
    resources = app / "Contents" / "Resources"
    macos.mkdir(parents=True)
    resources.mkdir(parents=True)

    executable = macos / "passh7-desktop"
    shutil.copy2(binary, executable)
    executable.chmod(0o755)
    plist = {
        "CFBundleDevelopmentRegion": "en",
        "CFBundleDisplayName": "PaSSH7",
        "CFBundleExecutable": "passh7-desktop",
        "CFBundleIconFile": "icon.icns",
        "CFBundleIdentifier": "studio.pas7.passh7",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "PaSSH7",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": args.version,
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
        "NSPrincipalClass": "NSApplication",
    }
    (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(plist))
    write_icns(args.icon.read_bytes(), resources / "icon.icns")
    (resources / "README-EXPERIMENTAL.txt").write_text(
        "PaSSH7 cross-compiled experimental macOS build.\n"
        "Unsigned, unnotarized, and NOT tested on a real Mac.\n"
        "Treat as a private development build only.\n"
        "Check WebKit, Vault, SFTP and SSH on the actual target machine.\n"
        "Local CLI launch is currently Windows-only; remote SSH CLI remains available.\n",
        encoding="utf-8",
    )
    archive = args.output / f"PaSSH7-macOS-{ARCHES[args.target]}-unsigned-experimental.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=7) as zf:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(args.output))
    with zipfile.ZipFile(archive) as zf:
        assert zf.testzip() is None
        info = zf.getinfo("PaSSH7.app/Contents/MacOS/passh7-desktop")
        if not (info.external_attr >> 16 & 0o111):
            raise RuntimeError("Archive lost executable permissions")
    print(f"Mach-O: {detected.strip()}")
    print(f"Unsigned app archive: {archive} ({archive.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
