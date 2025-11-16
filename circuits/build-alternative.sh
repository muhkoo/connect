#!/bin/bash

# Alternative build script that copies circomlib locally
echo "Alternative build script for Circom circuits..."

# Create build directory
mkdir -p build

# Copy circomlib circuits locally if not present
if [ ! -d "circomlib" ]; then
    echo "Copying circomlib circuits locally..."
    cp -r ../node_modules/circomlib ./
fi

# Compile HashKnowledge circuit
echo "Compiling HashKnowledge circuit..."
circom hashKnowledge.circom --r1cs --wasm --sym -o build/ || {
    echo "Failed to compile hashKnowledge.circom"
    exit 1
}

# Compile PreimagePoK circuit
echo "Compiling PreimagePoK circuit..."
circom preimagePoK.circom --r1cs --wasm --sym -o build/ || {
    echo "Failed to compile preimagePoK.circom"
    exit 1
}

echo "Generating proving keys..."

# Download powers of tau file if not present
if [ ! -f "build/pot15_final.ptau" ]; then
    echo "Downloading powers of tau..."
    curl -L -o build/pot15_final.ptau https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau
fi

# Generate zkey for HashKnowledge
echo "Generating zkey for HashKnowledge..."
snarkjs groth16 setup build/hashKnowledge.r1cs build/pot15_final.ptau build/hashKnowledge_0000.zkey
snarkjs zkey contribute build/hashKnowledge_0000.zkey build/hashKnowledge_0001.zkey --name="1st Contributor" -v -e="random entropy"
snarkjs zkey export verificationkey build/hashKnowledge_0001.zkey build/hashKnowledge_verification_key.json

# Generate zkey for PreimagePoK
echo "Generating zkey for PreimagePoK..."
snarkjs groth16 setup build/preimagePoK.r1cs build/pot15_final.ptau build/preimagePoK_0000.zkey
snarkjs zkey contribute build/preimagePoK_0000.zkey build/preimagePoK_0001.zkey --name="1st Contributor" -v -e="random entropy"
snarkjs zkey export verificationkey build/preimagePoK_0001.zkey build/preimagePoK_verification_key.json

echo "Circuit build complete!"