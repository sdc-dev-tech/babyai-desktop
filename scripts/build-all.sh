#!/usr/bin/env bash
# Full build pipeline: frontend → backend → electron installer
set -e

cd "$(dirname "$0")"

echo "════════════════════════════════════════"
echo "  babyAI Desktop — Full Build Pipeline"
echo "════════════════════════════════════════"

echo ""
echo "Step 1/3 — Build Next.js frontend"
bash build-frontend.sh

echo ""
echo "Step 2/3 — Freeze Python backend"
bash build-backend.sh

echo ""
echo "Step 3/3 — Package Electron installer"
cd ..
npm install
npm run build:win

echo ""
echo "✅ Done! Installer is in dist/"
