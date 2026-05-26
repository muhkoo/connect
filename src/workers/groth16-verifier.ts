/**
 * Cloudflare-Workers-compatible Groth16 ZK proof verifier.
 *
 * Drives the BN128 WASM module's exported pairing functions directly. Does NOT
 * use snarkjs/ffjavascript — those depend on runtime features (most notably
 * `URL.createObjectURL`) that CF Workers don't expose. See ROADMAP / CLAUDE.md.
 *
 * Two ways to initialize:
 *   1. `await initBn128Wasm()` — uses the bundled bn128.wasm (base64-inlined at
 *      build time via `@rollup/plugin-wasm`). Works in any modern JS runtime
 *      that allows runtime `WebAssembly.compile()` — Node, browsers, most
 *      Workers configurations.
 *   2. `await initBn128Wasm(myWasmModule)` — accepts a pre-compiled
 *      `WebAssembly.Module`. Lets a CF-Workers consumer keep the native pattern
 *      of importing `.wasm` so wrangler precompiles it at deploy time and the
 *      worker never pays for runtime compilation.
 */

import loadBundledBn128 from "./wasm/bn128.wasm";
import type { Groth16Proof, VerificationKey } from "../types/zk";

// Re-export the shared ZK types so workers consumers can pull everything from
// one place: `import { verifyGroth16, type Groth16Proof } from "@muhkoo/connect"`.
export type { Groth16Proof, VerificationKey } from "../types/zk";
export { PREIMAGE_POK_VERIFICATION_KEY } from "../types/zk";

// BN128 curve sizing
const n8q = 32;
const n8r = 32;
const f1size = n8q;
const g1size = f1size * 3;
const g2size = f1size * 6;
const ftsize = f1size * 12;

// Field modulus q (base field) and r (scalar field)
const q = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
const r = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

// Initial linear memory: 25 * 64KB = 1.6MB
const MEM_SIZE = 25;

export interface Bn128WasmInstance {
  instance: WebAssembly.Instance;
  memory: WebAssembly.Memory;
  initialPFree: number;
}

/**
 * Initialize the BN128 WASM module.
 *
 * @param wasmModule Optional pre-compiled `WebAssembly.Module`. If omitted, the
 *   bundled bn128.wasm (base64-inlined by `@rollup/plugin-wasm` at build time)
 *   is used. Passing your own module is the recommended path inside CF Workers,
 *   where wrangler can precompile a `.wasm` import at deploy time and avoid the
 *   runtime compile cost.
 */
export async function initBn128Wasm(wasmModule?: WebAssembly.Module): Promise<Bn128WasmInstance> {
  const memory = new WebAssembly.Memory({ initial: MEM_SIZE, maximum: 32767 });
  const imports = { env: { memory } };

  let instance: WebAssembly.Instance;
  if (wasmModule) {
    instance = await WebAssembly.instantiate(wasmModule, imports);
  } else {
    // Bundled fallback: the rollup plugin returns a loader function that takes
    // an import object and resolves to an instantiated WebAssembly.Instance.
    instance = await loadBundledBn128(imports as Record<string, Record<string, unknown>>);
  }

  // The first u32 in linear memory is the heap free pointer (set by the module
  // during static initialization). Remember it so we can reset between calls.
  const u32 = new Uint32Array(memory.buffer);
  const initialPFree = u32[0];
  return { instance, memory, initialPFree };
}

/**
 * Verify a Groth16 proof.
 *
 * Returns `false` (rather than throwing) for any structural problem — malformed
 * proof, out-of-range field elements, off-curve points, or a failed pairing.
 * Throws only for runtime/WASM faults.
 */
export async function verifyGroth16(
  wasmInstance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
  initialPFree: number,
  verificationKey: VerificationKey,
  proof: Groth16Proof,
  publicSignals: string[]
): Promise<boolean> {
  try {
    const vk = unstringifyBigInts(verificationKey);
    const p = unstringifyBigInts(proof);
    const signals: bigint[] = unstringifyBigInts(publicSignals);

    // Validate proof coordinates are within the base field
    if (!validateG1InField(p.pi_a)) return false;
    if (!validateG1InField(p.pi_c)) return false;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const val = typeof p.pi_b[i][j] === "bigint" ? p.pi_b[i][j] : BigInt(String(p.pi_b[i][j]));
        if (val >= q) return false;
      }
    }

    // Validate public signals are within the scalar field
    for (const signal of signals) {
      if (signal >= r) return false;
    }

    const exports = wasmInstance.exports;
    const u8 = new Uint8Array(memory.buffer);
    const u32 = new Uint32Array(memory.buffer);

    // Reset the WASM allocator's heap pointer between invocations
    u32[0] = initialPFree;

    const g1m_add = exports["g1m_add"] as CallableFunction;
    const g1m_timesScalar = exports["g1m_timesScalar"] as CallableFunction;
    const g1m_neg = exports["g1m_neg"] as CallableFunction;
    const g1m_inCurve = exports["g1m_inCurve"] as CallableFunction;
    const g2m_inCurve = exports["g2m_inCurve"] as CallableFunction;
    const ftm_one = exports["ftm_one"] as CallableFunction;
    const bn128_pairingEq4 = exports["bn128_pairingEq4"] as CallableFunction;

    // Compute vk_x = IC[0] + sum(IC[i+1] * signal[i])
    const pVkX = alloc(u32, g1size);
    const pIC0 = alloc(u32, g1size);
    writeG1Point(u8, pIC0, vk.IC[0], exports);
    u8.set(u8.slice(pIC0, pIC0 + g1size), pVkX);

    const pTemp = alloc(u32, g1size);
    const pScalar = alloc(u32, n8r);

    for (let i = 0; i < signals.length; i++) {
      const pICi = alloc(u32, g1size);
      writeG1Point(u8, pICi, vk.IC[i + 1], exports);

      u8.set(bigIntToLE(signals[i], n8r), pScalar);
      g1m_timesScalar(pICi, pScalar, n8r, pTemp);

      const pSum = alloc(u32, g1size);
      g1m_add(pVkX, pTemp, pSum);
      u8.set(u8.slice(pSum, pSum + g1size), pVkX);
    }

    // Allocate proof points
    const pA = alloc(u32, g1size);
    const pNegA = alloc(u32, g1size);
    const pB = alloc(u32, g2size);
    const pC = alloc(u32, g1size);

    writeG1Point(u8, pA, p.pi_a, exports);
    writeG2Point(u8, pB, p.pi_b, exports);
    writeG1Point(u8, pC, p.pi_c, exports);

    // Subgroup / on-curve checks
    if (!g1m_inCurve(pA)) return false;
    if (!g2m_inCurve(pB)) return false;
    if (!g1m_inCurve(pC)) return false;

    g1m_neg(pA, pNegA);

    // Verification key points
    const pAlpha = alloc(u32, g1size);
    const pBeta = alloc(u32, g2size);
    const pGamma = alloc(u32, g2size);
    const pDelta = alloc(u32, g2size);

    writeG1Point(u8, pAlpha, vk.vk_alpha_1, exports);
    writeG2Point(u8, pBeta, vk.vk_beta_2, exports);
    writeG2Point(u8, pGamma, vk.vk_gamma_2, exports);
    writeG2Point(u8, pDelta, vk.vk_delta_2, exports);

    // Target: F12 element representing 1
    const pOne = alloc(u32, ftsize);
    ftm_one(pOne);

    // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    const result = bn128_pairingEq4(
      pNegA, pB,
      pAlpha, pBeta,
      pVkX, pGamma,
      pC, pDelta,
      pOne
    );

    return result === 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseToBigInt(value: bigint | string | number): bigint {
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
    if (/^[0-9a-fA-F]+$/.test(value) && /[a-fA-F]/.test(value)) return BigInt("0x" + value);
    if (/^[0-9]+$/.test(value)) return BigInt(value);
    throw new Error(`Cannot convert ${value} to BigInt`);
  }
  if (typeof value === "number") return BigInt(value);
  return value;
}

function bigIntToLE(value: bigint | string | number, size: number): Uint8Array {
  const result = new Uint8Array(size);
  let v = parseToBigInt(value);
  for (let i = 0; i < size; i++) {
    result[i] = Number(v & 0xffn);
    v = v >> 8n;
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unstringifyBigInts(o: any): any {
  if (typeof o === "string") {
    try {
      if (/^[0-9]+$/.test(o) || /^0x[0-9a-fA-F]+$/.test(o) ||
          (/^[0-9a-fA-F]+$/.test(o) && /[a-fA-F]/.test(o))) {
        return parseToBigInt(o);
      }
    } catch {
      // fall through
    }
    return o;
  }
  if (Array.isArray(o)) return o.map(unstringifyBigInts);
  if (typeof o === "object" && o !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = {};
    for (const k of Object.keys(o)) res[k] = unstringifyBigInts(o[k]);
    return res;
  }
  return o;
}

function validateG1InField(point: (bigint | string | number)[]): boolean {
  const x = typeof point[0] === "bigint" ? point[0] : BigInt(String(point[0]));
  const y = typeof point[1] === "bigint" ? point[1] : BigInt(String(point[1]));
  return x < q && y < q;
}

function writeG1Point(
  u8: Uint8Array,
  offset: number,
  point: (bigint | string | number)[],
  exports: WebAssembly.Exports
): void {
  const x = point[0];
  const y = point[1];
  const z = point.length > 2 ? point[2] : 1n;

  u8.set(bigIntToLE(x, f1size), offset);
  u8.set(bigIntToLE(y, f1size), offset + f1size);
  u8.set(bigIntToLE(z, f1size), offset + 2 * f1size);

  const f1m_toMontgomery = exports["f1m_toMontgomery"] as CallableFunction;
  f1m_toMontgomery(offset, offset);
  f1m_toMontgomery(offset + f1size, offset + f1size);
  f1m_toMontgomery(offset + 2 * f1size, offset + 2 * f1size);
}

function writeG2Point(
  u8: Uint8Array,
  offset: number,
  point: (bigint | string | number)[][],
  exports: WebAssembly.Exports
): void {
  const x = point[0];
  const y = point[1];
  const z = point.length > 2 ? point[2] : [1n, 0n];

  u8.set(bigIntToLE(x[0], f1size), offset);
  u8.set(bigIntToLE(x[1], f1size), offset + f1size);
  u8.set(bigIntToLE(y[0], f1size), offset + 2 * f1size);
  u8.set(bigIntToLE(y[1], f1size), offset + 3 * f1size);
  u8.set(bigIntToLE(z[0], f1size), offset + 4 * f1size);
  u8.set(bigIntToLE(z[1], f1size), offset + 5 * f1size);

  const f1m_toMontgomery = exports["f1m_toMontgomery"] as CallableFunction;
  for (let i = 0; i < 6; i++) {
    f1m_toMontgomery(offset + i * f1size, offset + i * f1size);
  }
}

function alloc(u32: Uint32Array, size: number): number {
  while (u32[0] & 3) u32[0]++;
  const ptr = u32[0];
  u32[0] += size;
  return ptr;
}
