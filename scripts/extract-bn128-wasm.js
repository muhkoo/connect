/**
 * Script to extract the pre-compiled bn128 WASM bytecode
 * This generates a .wasm file that can be bundled with Cloudflare Workers
 *
 * Run with: node scripts/extract-bn128-wasm.js
 */

import { buildBn128 as buildBn128wasm } from "wasmcurves";
import { ModuleBuilder } from "wasmbuilder";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function extractBn128Wasm() {
    console.log("Building bn128 WASM module...");

    // Build the WASM module exactly as ffjavascript does
    const moduleBuilder = new ModuleBuilder();
    moduleBuilder.setMemory(25);
    buildBn128wasm(moduleBuilder);

    // Generate the WASM bytecode
    const wasmCode = moduleBuilder.build();

    console.log(`Generated WASM bytecode: ${wasmCode.length} bytes`);

    // Create output directory
    const outputDir = path.join(__dirname, "../src/workers/wasm");
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write the WASM file
    const wasmPath = path.join(outputDir, "bn128.wasm");
    fs.writeFileSync(wasmPath, Buffer.from(wasmCode));
    console.log(`Written WASM to: ${wasmPath}`);

    console.log("\nDone!");
}

extractBn128Wasm().catch(console.error);
