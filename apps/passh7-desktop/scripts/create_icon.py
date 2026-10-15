#!/usr/bin/env python3
"""Create the deterministic provisional PaSSH7 window icon with stdlib only."""
import pathlib
import struct
import zlib

size = 64
rows = []
for y in range(size):
    row = bytearray([0])
    for x in range(size):
        border = x < 4 or x > 59 or y < 4 or y > 59
        glyph = (14 <= x < 25 and 19 <= y < 24 and x-14 <= y-19) or (14 <= x < 25 and 24 <= y < 29 and x-14 <= 28-y) or (28 <= x < 44 and 36 <= y < 41)
        row.extend((15, 22, 36, 255) if border else (240, 248, 255, 255) if glyph else (34, 105, 200, 255))
    rows.append(bytes(row))

def chunk(name, data):
    return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)

out = pathlib.Path(__file__).resolve().parents[1] / "src-tauri" / "icons" / "icon.png"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))
print(f"Generated {out}")

# Windows icon: ICO header + one 64px PNG image. No third-party deps.
png = out.read_bytes()
ico = out.with_name("icon.ico")
ico.write_bytes(struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(png), 22) + png)
print(f"Generated {ico}")
