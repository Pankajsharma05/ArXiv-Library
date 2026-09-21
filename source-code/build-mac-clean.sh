#!/usr/bin/env bash
# Clean build for ArXivLibrary on macOS (Apple Silicon).
# Use this when a fix "isn't showing up" — it clears stale artifacts.
set -e

echo "==> ArXivLibrary clean build"

# 1. Make sure Rust is on PATH (rustup default location).
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

# 2. Remove any previously installed app so macOS can't launch a stale copy.
#    (The old lowercase name and the new ArXivLibrary, both in common spots.)
echo "==> Removing old installed .app copies"
rm -rf "/Applications/ArXivLibrary.app" 2>/dev/null || true
rm -rf "/Applications/ArxivLibrary.app" 2>/dev/null || true
rm -rf "$HOME/Applications/ArXivLibrary.app" 2>/dev/null || true
rm -rf "$HOME/Applications/ArxivLibrary.app" 2>/dev/null || true

# 3. Clear the webview asset cache for this app (this is the usual culprit
#    for "frontend changes not appearing"). The WebKit cache is keyed by the
#    bundle identifier com.pankaj.arxivlibrary.
echo "==> Clearing webview/HTTP caches"
rm -rf "$HOME/Library/Caches/com.pankaj.arxivlibrary" 2>/dev/null || true
rm -rf "$HOME/Library/WebKit/com.pankaj.arxivlibrary" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/ArXivLibrary" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/ArxivLibrary" 2>/dev/null || true

# NOTE: We deliberately do NOT delete:
#   ~/Library/Application Support/ArxivLibrary
# That folder holds your library.sqlite, settings.json, and downloaded PDFs.
# Leaving it untouched keeps all your saved papers, collections, and tags.

cd "$(dirname "$0")/src-tauri"

# 4. Decide how clean to go. Pass "full" for a from-scratch Rust rebuild.
if [ "$1" == "full" ]; then
  echo "==> FULL clean: removing Rust target/ (slower, ~ minutes)"
  cargo clean
else
  echo "==> Incremental Rust build (pass 'full' as an argument to force cargo clean)"
fi

cd ..

# 5. Build via the Tauri CLI.
echo "==> Building (cargo tauri build)"
cargo tauri build

echo ""
echo "==> Done. The app is at:"
echo "    src-tauri/target/release/bundle/macos/ArXivLibrary.app"
echo "    (or the .dmg under .../bundle/dmg/)"
echo ""
echo "Drag ArXivLibrary.app to /Applications, or run it in place."
