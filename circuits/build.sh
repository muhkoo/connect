#!/bin/bash

# Build script for Circom circuits
# Requires circom and snarkjs to be installed

echo "Building Circom circuits..."

# Create build directory
mkdir -p build

# Check if circom is available
if ! command -v circom &> /dev/null; then
    echo "Error: circom is not installed or not in PATH"
    echo "Please install circom2: https://docs.circom.io/getting-started/installation/"
    echo "You can install it with: cargo install --git https://github.com/iden3/circom.git"
    exit 1
fi

# Check if snarkjs is available
if ! command -v snarkjs &> /dev/null; then
    echo "Error: snarkjs is not installed globally"
    echo "Please install snarkjs: npm install -g snarkjs"
    exit 1
fi

# Install circomlib if not present
if [ ! -d "../node_modules/circomlib" ]; then
    echo "Installing circomlib..."
    cd ..
    npm install circomlib
    cd circuits
fi

# Compile HashKnowledge circuit
echo "Compiling HashKnowledge circuit..."
circom hashKnowledge.circom --r1cs --wasm --sym -o build/ -l ../node_modules || {
    echo "Failed to compile hashKnowledge.circom"
    echo "Make sure circom2 is properly installed and circomlib is installed"
    exit 1
}

# Compile PreimagePoK circuit
echo "Compiling PreimagePoK circuit..."
circom preimagePoK.circom --r1cs --wasm --sym -o build/ -l ../node_modules || {
    echo "Failed to compile preimagePoK.circom"
    echo "Make sure circom2 is properly installed and circomlib is installed"
    exit 1
}

echo "Generating proving keys..."

# Download powers of tau file (for testing - in production use a ceremony)
if [ ! -f "build/pot15_final.ptau" ]; then
    echo "Downloading powers of tau..."
    # Download from the Hermez bucket with the correct URL
    curl -L -o build/pot15_final.ptau "https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau" || {
        echo "Failed to download powers of tau file"
        exit 1
    }

    # Check file size - should be around 330MB for pot15
    FILE_SIZE=$(wc -c < build/pot15_final.ptau)
    if [ "$FILE_SIZE" -lt 100000000 ]; then
        echo "Error: Downloaded file is too small (${FILE_SIZE} bytes). Download may have failed."
        echo "Removing invalid file..."
        rm -f build/pot15_final.ptau

        echo ""
        echo "Alternative: You can manually download the file from:"
        echo "https://github.com/iden3/snarkjs#7-prepare-phase-2"
        echo ""
        echo "Or use a smaller powers of tau file for testing (pot12):"
        echo "curl -L -o build/pot12_final.ptau https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau"
        exit 1
    fi

    echo "Powers of tau file downloaded successfully (${FILE_SIZE} bytes)"
fi

# Check if r1cs files were created
if [ ! -f "build/hashKnowledge.r1cs" ]; then
    echo "Error: hashKnowledge.r1cs not found. Circuit compilation failed."
    exit 1
fi

if [ ! -f "build/preimagePoK.r1cs" ]; then
    echo "Error: preimagePoK.r1cs not found. Circuit compilation failed."
    exit 1
fi

# Generate zkey for HashKnowledge
echo "Generating zkey for HashKnowledge..."
snarkjs groth16 setup build/hashKnowledge.r1cs build/pot15_final.ptau build/hashKnowledge_0000.zkey
if [ ! -f "build/hashKnowledge_0000.zkey" ]; then
    echo "Error: Failed to generate hashKnowledge_0000.zkey"
    exit 1
fi

snarkjs zkey contribute build/hashKnowledge_0000.zkey build/hashKnowledge_0001.zkey --name="1st Contributor" -v -e="random entropy"
snarkjs zkey export verificationkey build/hashKnowledge_0001.zkey build/hashKnowledge_verification_key.json

# Generate zkey for PreimagePoK
echo "Generating zkey for PreimagePoK..."
snarkjs groth16 setup build/preimagePoK.r1cs build/pot15_final.ptau build/preimagePoK_0000.zkey
if [ ! -f "build/preimagePoK_0000.zkey" ]; then
    echo "Error: Failed to generate preimagePoK_0000.zkey"
    exit 1
fi

snarkjs zkey contribute build/preimagePoK_0000.zkey build/preimagePoK_0001.zkey --name="1st Contributor" -v -e="random entropy"
snarkjs zkey export verificationkey build/preimagePoK_0001.zkey build/preimagePoK_verification_key.json

echo ""
echo "Circuit build complete!"
echo ""
echo "Generated files:"
if [ -f "build/hashKnowledge_js/hashKnowledge.wasm" ]; then
    echo "  ✓ build/hashKnowledge_js/hashKnowledge.wasm"
else
    echo "  ✗ build/hashKnowledge_js/hashKnowledge.wasm (not found)"
fi

if [ -f "build/hashKnowledge_0001.zkey" ]; then
    echo "  ✓ build/hashKnowledge_0001.zkey"
else
    echo "  ✗ build/hashKnowledge_0001.zkey (not found)"
fi

if [ -f "build/hashKnowledge_verification_key.json" ]; then
    echo "  ✓ build/hashKnowledge_verification_key.json"
else
    echo "  ✗ build/hashKnowledge_verification_key.json (not found)"
fi

if [ -f "build/preimagePoK_js/preimagePoK.wasm" ]; then
    echo "  ✓ build/preimagePoK_js/preimagePoK.wasm"
else
    echo "  ✗ build/preimagePoK_js/preimagePoK.wasm (not found)"
fi

if [ -f "build/preimagePoK_0001.zkey" ]; then
    echo "  ✓ build/preimagePoK_0001.zkey"
else
    echo "  ✗ build/preimagePoK_0001.zkey (not found)"
fi

if [ -f "build/preimagePoK_verification_key.json" ]; then
    echo "  ✓ build/preimagePoK_verification_key.json"
else
    echo "  ✗ build/preimagePoK_verification_key.json (not found)"
fi