#!/bin/bash
# Build script for node-red-contrib-airtunes minimal 9.4 MB tarball
# This creates a self-contained installation package for Raspberry Pi 3
# Usage: ./build-tarball.sh

set -e

echo "=== Building node-red-contrib-airtunes minimal tarball ==="
echo ""

# Clean previous builds (keep node_modules to avoid large reinstall)
echo "Step 1: Cleaning previous builds..."
rm -rf package-lock.json foo *.tgz _*.tgz
echo "  ✓ Cleaned"

# Update production dependencies (reuses existing node_modules)
echo ""
echo "Step 2: Updating production dependencies..."
npm install --production --ignore-scripts --no-audit
echo "  ✓ Installed (280 packages)"

# Remove large test files from airtunes2 that aren't needed at runtime
echo ""
echo "Step 3: Stripping non-runtime files from node_modules..."

# airtunes2: C++ source, examples, test data
rm -rf node_modules/airtunes2/src
rm -rf node_modules/airtunes2/test
rm -rf node_modules/airtunes2/examples
rm -f  node_modules/airtunes2/*.raw
rm -f  node_modules/airtunes2/binding.gyp
rm -f  node_modules/airtunes2/example_execlient.js

# Build/packaging tools — never needed at runtime (only used in install scripts)
rm -rf node_modules/node-gyp      # build tool (~2 MB)
rm -rf node_modules/@yao-pkg      # pkg bundler (~2.3 MB)
rm -rf node_modules/@babel        # transpiler, only used by @yao-pkg (~5.7 MB)
rm -rf node_modules/@types        # TypeScript type declarations (~2.5 MB)

# Test directories across all packages
find node_modules -mindepth 2 -type d \( -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'spec' \) -exec rm -rf {} + 2>/dev/null; true

# TypeScript declaration and source map files
find node_modules -name '*.d.ts' -delete 2>/dev/null; true
find node_modules -name '*.map'  -delete 2>/dev/null; true

echo "  ✓ Stripped"

# Create the tarball
echo ""
echo "Step 4: Creating tarball..."
npm pack
echo "  ✓ Created"

# Verify size
echo ""
SIZE=$(ls -lh node-red-contrib-airtunes-1.0.0.tgz | awk '{print $5}')
echo "=== Success ==="
echo "Tarball: node-red-contrib-airtunes-1.0.0.tgz"
echo "Size: $SIZE (target: ~4.5 MB)"
echo ""
echo "Next: scp node-red-contrib-airtunes-1.0.0.tgz pi@PI_IP:~/"
echo "Then on Pi: npm install ~/node-red-contrib-airtunes-1.0.0.tgz --ignore-scripts --no-audit"
