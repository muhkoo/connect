#!/bin/bash

# Script to download powers of tau files
echo "Downloading Powers of Tau file for circuit setup..."

mkdir -p build

# Choose which size to download
echo ""
echo "Choose Powers of Tau file size:"
echo "1) pot12 (~55MB) - Good for testing, supports up to 2^12 constraints"
echo "2) pot15 (~330MB) - Good for production, supports up to 2^15 constraints"
echo ""
read -p "Enter choice (1 or 2): " choice

case $choice in
    1)
        FILENAME="pot12_final.ptau"
        URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau"
        MIN_SIZE=50000000
        ;;
    2)
        FILENAME="pot15_final.ptau"
        URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau"
        MIN_SIZE=300000000
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "Downloading $FILENAME..."
echo "This may take a few minutes..."

# Download with progress bar
curl -L --progress-bar -o "build/$FILENAME" "$URL"

# Check file size
FILE_SIZE=$(wc -c < "build/$FILENAME" 2>/dev/null || echo "0")

if [ "$FILE_SIZE" -lt "$MIN_SIZE" ]; then
    echo ""
    echo "❌ Error: Downloaded file is too small (${FILE_SIZE} bytes)."
    echo "Download may have failed or been blocked."
    rm -f "build/$FILENAME"

    echo ""
    echo "Alternative download options:"
    echo ""
    echo "1. Manual download from Dropbox:"
    echo "   https://www.dropbox.com/sh/mn47gnepqu88mzl/AACaJkBU7mmCq8uU8ml0-0fma?dl=0"
    echo "   Download 'powersOfTau28_hez_final_12.ptau' and save as circuits/build/$FILENAME"
    echo ""
    echo "2. Direct wget (if you have wget installed):"
    echo "   wget -O build/$FILENAME $URL"
    echo ""
    echo "3. Using a different network or VPN"

    exit 1
else
    echo ""
    echo "✅ Successfully downloaded $FILENAME ($(($FILE_SIZE / 1024 / 1024)) MB)"
    echo "   Saved to: circuits/build/$FILENAME"
fi