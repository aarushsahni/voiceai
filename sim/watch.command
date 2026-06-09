#!/bin/bash
# Double-click this file (Finder) to launch the IVR call viewer.
# It starts the local server and opens your browser automatically.
cd "$(dirname "$0")/.." || exit 1

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)…"
  npm install
fi

if [ ! -f .env.local ]; then
  echo ""
  echo "⚠️  No .env.local found. Create it in the project root with your key:"
  echo "    OPENAI_API_KEY=sk-..."
  echo ""
  read -r -p "Press Enter to exit."
  exit 1
fi

npm run sim:watch
