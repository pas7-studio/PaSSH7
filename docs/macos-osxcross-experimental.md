# Experimental macOS build on Ubuntu: osxcross

**Status: experimental, not a release.** Tauri 2's official macOS bundler is meant to run on macOS. This workflow cross-compiles the Rust executable with osxcross on Linux and creates an **unsigned** .app manually. It does not prove that WebKit, file dialogs, SSH, SFTP or Vault permissions work correctly on a Mac.

## Source and CI

- Source branch: feat/macos-osxcross-build (based on the latest PaSSH7 UI work).
- Workflow: .github/workflows/macos-osxcross.yml.
- Build script: apps/passh7-desktop/scripts/build-macos-osxcross.sh.
- Packager: apps/passh7-desktop/scripts/package_macos_app.py.
- Initial target: Apple Silicon aarch64-apple-darwin; the script also accepts Intel x86_64-apple-darwin.
- Only after successful CI: PaSSH7-macOS-arm64-osxcross-EXPERIMENTAL containing an unsigned experimental ZIP.
- Neither SDK nor toolchain nor signing secrets are included in app archives.

## Apple SDK licensing

osxcross requires the Apple SDK. Apple's Xcode and Apple SDKs Agreement limits authorized execution to Apple-branded hardware running macOS. Review the license before using SDKs with Linux cross-compilers. An externally mirrored SDK does not make such use authorized. For a compliant public distribution pipeline, use a macOS builder.

- https://github.com/tpoechtrager/osxcross
- https://www.apple.com/legal/sla/docs/xcode.pdf
- https://v2.tauri.app/distribute/macos-application-bundle/

## Limitations

- No code signing or notarization. Gatekeeper can block the app. Only private, trusted development testing is intended.
- Current local CLI launcher is Windows-specific. Remote agent CLIs over SSH require independent testing on macOS.
- Not an official Tauri-generated DMG. The ZIP is assembled manually.
- CI must fail when Mach-O compilation fails; never label uncompiled sources as a macOS app.

## Acceptance on a real Mac

1. Inspect the extracted .app and Darwin binary architecture.
2. Check app launch and native WebKit rendering.
3. Initialize/lock/unlock Vault and verify private-file permissions.
4. Connect to two SSH servers with pinned host keys, open PTYs and switch among them.
5. Test SFTP, Docker SSH commands, port forwarding and the remote CLI agent screen.
6. Verify dialogs and reconnection after a process restart.
7. For public delivery, build and sign/notarize on an authorized Mac.
