#!/usr/bin/env bash
# Build ArXivLibrary for LINUX ONLY — lean and fast.
#
# Produces:
#   .deb       — smallest; uses the system's WebKitGTK (recommended for Debian/Ubuntu)
#   .AppImage  — portable single-file; larger because it bundles the runtime
#   .rpm       — for Fedora/RHEL (if the tooling is present)
#
# PREREQUISITES (one-time), Debian/Ubuntu:
#   sudo apt update
#   sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
#     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
#     libgtk-3-dev patchelf
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   cargo install tauri-cli --version "^2"
#
# Run:  ./build-linux.sh              (builds .deb + .AppImage + .rpm)
#       ./build-linux.sh deb          (builds ONLY the lean .deb — fastest, smallest)

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-all}"

echo "==> Building ArXivLibrary for Linux..."
if [ "$TARGET" = "deb" ]; then
  echo "    (deb only — the lean build)"
  cargo tauri build --bundles deb
else
  cargo tauri build
fi

echo
echo "==> Done. Bundles are in src-tauri/target/release/bundle/ :"
echo "    deb/        .deb       (smallest — install with: sudo dpkg -i <file>.deb)"
echo "    appimage/   .AppImage  (portable — chmod +x then run)"
echo "    rpm/        .rpm       (Fedora/RHEL, if built)"
echo
echo "Raw executable (no installer, smallest to run):"
echo "    src-tauri/target/release/ArXivLibrary"
