#!/usr/bin/env bash
# exit on error
set -o errexit

echo "--- INSTALLING NODE DEPENDENCIES ---"
npm install

echo "--- INSTALLING PYTHON DEPENDENCIES ---"
# Check if python3 and pip are available
if command -v python3 &>/dev/null; then
    python3 -m pip install --upgrade pip
    python3 -m pip install -r requirements.txt
else
    echo "WARNING: python3 not found. Python scripts may fail."
fi

echo "--- RUNNING PRISMA GENERATE ---"
npx prisma generate

echo "--- BUILD COMPLETE ---"
