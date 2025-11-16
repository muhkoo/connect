#!/bin/bash

# Test build script using smaller powers of tau file
echo "Building Circom circuits (test version with pot12)..."

# Create build directory
mkdir -p build

# Check if circom is available
if ! command -v circom &> /dev/null; then
    echo "Error: circom is not installed or not in PATH"
    exit 1
fi

# Check if snarkjs is available
if ! command -v snarkjs &> /dev/null; then
    echo "Error: snarkjs is not installed globally"
    exit 1
fi

# Compile HashKnowledge circuit
echo "Compiling HashKnowledge circuit..."
circom hashKnowledge.circom --r1cs --wasm --sym -o build/ -l ../node_modules || {
    echo "Failed to compile hashKnowledge.circom"
    exit 1
}

# Compile PreimagePoK circuit
echo "Compiling PreimagePoK circuit..."
circom preimagePoK.circom --r1cs --wasm --sym -o build/ -l ../node_modules || {
    echo "Failed to compile preimagePoK.circom"
    exit 1
}

echo "Generating proving keys..."

# Use a smaller powers of tau file for testing (pot12 = ~55MB instead of pot15 = ~330MB)
if [ ! -f "build/pot12_final.ptau" ]; then
    echo "Downloading powers of tau (pot12 for testing)..."

    # Try multiple download sources
    echo "Attempting to download from Hermez..."
    if ! curl -L --fail -o build/pot12_final.ptau "https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau" 2>/dev/null; then
        echo "Hermez download failed, trying alternative source..."

        # Alternative: Direct from GitHub releases
        if ! curl -L --fail -o build/pot12_final.ptau "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau" 2>/dev/null; then
            echo ""
            echo "Failed to download powers of tau file."
            echo ""
            echo "Please manually download the file from one of these sources:"
            echo "1. https://github.com/iden3/snarkjs#powers-of-tau"
            echo "2. https://www.dropbox.com/sh/mn47gnepqu88mzl/AACaJkBU7mmCq8uU8ml0-0fma?dl=0"
            echo ""
            echo "Download 'powersOfTau28_hez_final_12.ptau' and save it as:"
            echo "  circuits/build/pot12_final.ptau"
            exit 1
        fi
    fi

    # Verify file size (should be around 55MB for pot12)
    FILE_SIZE=$(wc -c < build/pot12_final.ptau 2>/dev/null || echo "0")
    if [ "$FILE_SIZE" -lt 50000000 ]; then
        echo "Error: Downloaded file is too small (${FILE_SIZE} bytes)."
        rm -f build/pot12_final.ptau
        exit 1
    fi

    echo "Powers of tau file downloaded successfully (${FILE_SIZE} bytes)"
fi

# Generate zkey for HashKnowledge
echo "Generating zkey for HashKnowledge..."
snarkjs groth16 setup build/hashKnowledge.r1cs build/pot12_final.ptau build/hashKnowledge_0000.zkey

if [ ! -f "build/hashKnowledge_0000.zkey" ]; then
    echo "Error: Failed to generate hashKnowledge_0000.zkey"
    exit 1
fi

echo "Contributing to hashKnowledge zkey..."
snarkjs zkey contribute build/hashKnowledge_0000.zkey build/hashKnowledge_0001.zkey --name="1st Contributor" -v -e="test entropy"

echo "Exporting hashKnowledge verification key..."
snarkjs zkey export verificationkey build/hashKnowledge_0001.zkey build/hashKnowledge_verification_key.json

# Generate zkey for PreimagePoK
echo "Generating zkey for PreimagePoK..."
snarkjs groth16 setup build/preimagePoK.r1cs build/pot12_final.ptau build/preimagePoK_0000.zkey

if [ ! -f "build/preimagePoK_0000.zkey" ]; then
    echo "Error: Failed to generate preimagePoK_0000.zkey"
    exit 1
fi

echo "Contributing to preimagePoK zkey..."
snarkjs zkey contribute build/preimagePoK_0000.zkey build/preimagePoK_0001.zkey --name="1st Contributor" -v -e="test entropy"

echo "Exporting preimagePoK verification key..."
snarkjs zkey export verificationkey build/preimagePoK_0001.zkey build/preimagePoK_verification_key.json

echo ""
echo "✅ Circuit build complete!"
echo ""
echo "Generated files:"
ls -lh build/*.zkey build/*.json build/*_js/*.wasm 2>/dev/null | awk '{print "  - " $NF " (" $5 ")"}'