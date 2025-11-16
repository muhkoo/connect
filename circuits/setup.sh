#!/bin/bash

echo "Setting up Circom and dependencies..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Rust is installed (needed for circom2)
if ! command -v cargo &> /dev/null; then
    echo -e "${RED}Error: Rust is not installed${NC}"
    echo "Please install Rust first: https://www.rust-lang.org/tools/install"
    echo "Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

# Install circom2 from source (the correct version)
echo -e "${YELLOW}Installing circom2 from source...${NC}"
echo "This may take a few minutes..."

# Create a temporary directory for installation
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Clone and install circom2
git clone https://github.com/iden3/circom.git
cd circom
cargo build --release
cargo install --path circom

# Check if installation was successful
if command -v circom &> /dev/null; then
    echo -e "${GREEN}✓ circom2 installed successfully${NC}"
    circom --version
else
    echo -e "${RED}✗ Failed to install circom2${NC}"
    echo "Please check the error messages above"
    exit 1
fi

# Go back to project directory
cd -

# Install snarkjs globally if not present
if ! command -v snarkjs &> /dev/null; then
    echo -e "${YELLOW}Installing snarkjs globally...${NC}"
    npm install -g snarkjs
else
    echo -e "${GREEN}✓ snarkjs is already installed${NC}"
fi

# Install circomlib locally
echo -e "${YELLOW}Installing circomlib...${NC}"
npm install circomlib

# Clean up
rm -rf "$TEMP_DIR"

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "You can now run the build script:"
echo "  cd circuits"
echo "  ./build.sh"