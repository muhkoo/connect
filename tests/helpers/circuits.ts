/**
 * Shared circuit loader for the ZK test suites.
 *
 * `src/crypto/ZeroKnowledge.ts` no longer loads circuit artifacts itself (that
 * self-loading was removed so the module stays runtime-agnostic). Callers now
 * inject the wasm/zkey/verification-key buffers via `initializeCircuits()`.
 * These helpers do exactly that for the checked-in artifacts in
 * `circuits/build/`.
 *
 * Paths resolve from `import.meta.url`, not `process.cwd()`, so the suites work
 * regardless of vitest's working directory.
 *
 * Note: always use the `_0001.zkey` files — those are post-contribution and are
 * the ones the checked-in `*_verification_key.json` files correspond to.
 */
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  initializeCircuits,
  type CircuitBufferConfig
} from '../../src/crypto/ZeroKnowledge';
import type { VerificationKey } from '../../src/types/zk';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root: tests/helpers -> tests -> <root> */
const REPO_ROOT = join(HERE, '..', '..');
const CIRCUITS_DIR = join(REPO_ROOT, 'circuits', 'build');

async function readBytes(path: string): Promise<Uint8Array> {
  const buf = await readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function readVerificationKey(path: string): Promise<VerificationKey> {
  return JSON.parse(await readFile(path, 'utf8')) as VerificationKey;
}

async function loadCircuit(
  wasmPath: string,
  zkeyPath: string,
  vkeyPath: string
): Promise<CircuitBufferConfig> {
  const [wasm, zkey, verificationKey] = await Promise.all([
    readBytes(wasmPath),
    readBytes(zkeyPath),
    readVerificationKey(vkeyPath)
  ]);
  return { wasm, zkey, verificationKey };
}

/** Load + install the `preimagePoK` circuit buffers into `PreimagePoK`. */
export async function loadPreimagePoKCircuit(): Promise<CircuitBufferConfig> {
  const preimagePoK = await loadCircuit(
    join(CIRCUITS_DIR, 'preimagePoK_js', 'preimagePoK.wasm'),
    join(CIRCUITS_DIR, 'preimagePoK_0001.zkey'),
    join(CIRCUITS_DIR, 'preimagePoK_verification_key.json')
  );
  initializeCircuits({ preimagePoK });
  return preimagePoK;
}

/** Load + install the `hashKnowledge` circuit buffers into `HashKnowledge`. */
export async function loadHashKnowledgeCircuit(): Promise<CircuitBufferConfig> {
  const hashKnowledge = await loadCircuit(
    join(CIRCUITS_DIR, 'hashKnowledge_js', 'hashKnowledge.wasm'),
    join(CIRCUITS_DIR, 'hashKnowledge_0001.zkey'),
    join(CIRCUITS_DIR, 'hashKnowledge_verification_key.json')
  );
  initializeCircuits({ hashKnowledge });
  return hashKnowledge;
}

/** Load + install both circuits in one go. */
export async function initAllCircuits(): Promise<void> {
  await Promise.all([loadHashKnowledgeCircuit(), loadPreimagePoKCircuit()]);
}
