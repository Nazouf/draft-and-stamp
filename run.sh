#!/bin/bash
# Double-click this (or run "bash run.sh" in a terminal) to start Draft & Stamp.
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "================================================================"
  echo " First-time setup needed:"
  echo " 1. Open the new '.env' file in this folder with any text editor"
  echo " 2. Replace 'your-key-here' with your real Gemini API key"
  echo "    (free, no card: https://aistudio.google.com)"
  echo " 3. Save the file, then run this script again"
  echo "================================================================"
  read -p "Press Enter to close..."
  exit 0
fi

echo "Starting Draft & Stamp..."
echo "Open this in your browser:  http://localhost:3000"
echo "(Press Ctrl+C in this window to stop it)"
npm start
