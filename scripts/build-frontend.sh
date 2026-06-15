#!/usr/bin/env bash
# Build the Next.js frontend in standalone mode.
set -e

FRONTEND_SRC="../../babyAI"
OUT_DIR="../vendor/frontend"

echo "→ Building Next.js frontend..."
cd "$FRONTEND_SRC"

# Standalone output bundles node_modules needed to run `node server.js`
DESKTOP_BUILD=1 NEXT_PUBLIC_API_URL="http://127.0.0.1:8000" \
next build

echo "→ Copying standalone output..."
rm -rf "$OUT_DIR"
cp -r .next/standalone "$OUT_DIR"
cp -r .next/static "$OUT_DIR/.next/static"
cp -r public "$OUT_DIR/public" 2>/dev/null || true

echo "✓ Frontend built → vendor/frontend"
