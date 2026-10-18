#!/usr/bin/env bash
# Experimental Tauri 2 Darwin cross-build on Linux with osxcross.
# Apple SDK must be supplied explicitly. It is never included in artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET="${PASSH7_MACOS_TARGET:-aarch64-apple-darwin}"
case "$TARGET" in
  aarch64-apple-darwin) TOOL_PREFIX="oa64"; COMPILER_NAME="arm64" ;;
  x86_64-apple-darwin) TOOL_PREFIX="o64"; COMPILER_NAME="x86_64" ;;
  *) echo "Unsupported macOS target: $TARGET" >&2; exit 2 ;;
esac

BUILD_DIR="${PASSH7_OSXCROSS_DIR:-${RUNNER_TEMP:-/tmp}/passh7-osxcross}"
SOURCE="$BUILD_DIR/source"
TARGET_DIR="$BUILD_DIR/target"
SDK_ARCHIVE="$BUILD_DIR/MacOSX15.5.sdk.tar.xz"
mkdir -p "$BUILD_DIR"

echo "Mac target: $TARGET"
echo "Linux host: $(uname -sm)"
if [[ ! -x "$TARGET_DIR/bin/${TOOL_PREFIX}-clang" ]]; then
  if [[ ! -f "$SDK_ARCHIVE" ]]; then
    if [[ -n "${PASSH7_MACOS_SDK_ARCHIVE:-}" ]]; then
      cp -- "$PASSH7_MACOS_SDK_ARCHIVE" "$SDK_ARCHIVE"
    elif [[ -n "${PASSH7_MACOS_SDK_URL:-}" ]]; then
      echo "Downloading configured macOS SDK input (not included in artifact)"
      curl -fL --retry 3 --retry-delay 5 --output "$SDK_ARCHIVE" "$PASSH7_MACOS_SDK_URL"
      if [[ -n "${PASSH7_MACOS_SDK_SHA256:-}" ]]; then
        printf '%s  %s\n' "$PASSH7_MACOS_SDK_SHA256" "$SDK_ARCHIVE" | sha256sum -c -
      else
        echo "::warning::SDK checksum not configured. Provide PASSH7_MACOS_SDK_SHA256 for provenance."
      fi
    else
      echo "::error::Mac SDK not found. Supply PASSH7_MACOS_SDK_ARCHIVE or PASSH7_MACOS_SDK_URL."
      exit 3
    fi
  fi
  if [[ ! -d "$SOURCE/.git" ]]; then
    git clone --depth=1 https://github.com/tpoechtrager/osxcross.git "$SOURCE"
  fi
  cp -f "$SDK_ARCHIVE" "$SOURCE/tarballs/"
  echo "Building osxcross (LLVM flavor)"
  (
    cd "$SOURCE"
    UNATTENDED=1 BUILD_FLAVOR=llvm ENABLE_ARCHS="arm64 x86_64" \
      OSX_VERSION_MIN=11.0 TARGET_DIR="$TARGET_DIR" ./build.sh
  )
fi

export PATH="$TARGET_DIR/bin:$PATH"
export LD_LIBRARY_PATH="$TARGET_DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
LINKER="$TARGET_DIR/bin/${TOOL_PREFIX}-clang"
if [[ ! -x "$LINKER" ]]; then
  LINKER="$(find "$TARGET_DIR/bin" -maxdepth 1 -name "${COMPILER_NAME}-apple-darwin*-clang" -type f | head -1)"
fi
if [[ -z "$LINKER" || ! -x "$LINKER" ]]; then
  echo "::error::No osxcross clang linker found for $TARGET in $TARGET_DIR/bin"
  ls "$TARGET_DIR/bin" | head -50
  exit 4
fi
echo "Darwin linker: $LINKER"

printf 'int main(void) { return 0; }\n' | "$LINKER" -x c - -o "$BUILD_DIR/macho-test"
file "$BUILD_DIR/macho-test"
file "$BUILD_DIR/macho-test" | grep -q Mach-O

rustup target add "$TARGET"
if [[ "$TARGET" = aarch64-apple-darwin ]]; then
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$LINKER"
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS="-l framework=WebKit"
  export CC_aarch64_apple_darwin="$LINKER"
else
  export CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER="$LINKER"
  export CARGO_TARGET_X86_64_APPLE_DARWIN_RUSTFLAGS="-l framework=WebKit"
  export CC_x86_64_apple_darwin="$LINKER"
fi

export MACOSX_DEPLOYMENT_TARGET=11.0
export PASSH7_BUILD_COMMIT="${GITHUB_SHA:-local}"
export PASSH7_BUILD_TIMESTAMP="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
export PASSH7_BUILD_RUN="${GITHUB_RUN_NUMBER:-local}"

python3 "$ROOT/apps/passh7-desktop/scripts/create_icon.py"
npm install --no-audit --no-fund --prefix "$ROOT/apps/passh7-desktop"
npm run build --prefix "$ROOT/apps/passh7-desktop"
cargo build --release --manifest-path "$ROOT/apps/passh7-desktop/src-tauri/Cargo.toml" \
  --target "$TARGET" --bin passh7-desktop

BINARY="$ROOT/apps/passh7-desktop/src-tauri/target/$TARGET/release/passh7-desktop"
python3 "$ROOT/apps/passh7-desktop/scripts/package_macos_app.py" \
  --target "$TARGET" --binary "$BINARY" \
  --icon "$ROOT/apps/passh7-desktop/src-tauri/icons/icon.png" \
  --output "$ROOT/apps/passh7-desktop/macos-experimental"
echo "macOS experimental archive complete."
