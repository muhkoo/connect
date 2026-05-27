/**
 * Universal wasm-bindgen glue for `wasm-reed-solomon-erasure` (v0.2.2 — Rust
 * Reed–Solomon erasure-coding library compiled with `wasm-pack --target nodejs`).
 *
 * The upstream npm package ships `wasm_reed_solomon_erasure.js` which uses
 * `require('fs').readFileSync()` to load the WASM file at module load time —
 * that hard-codes Node and breaks browsers / CF Workers. This file is a port
 * of that glue with the Node-only pieces removed:
 *
 *   - `TextDecoder` is taken from the global (available in Node 12+, every
 *     modern browser, and Workers — no `require('util')`).
 *   - The WASM module is loaded via the rollup-inlined `.wasm` import, the
 *     same `targetEnv: 'auto-inline'` path the bn128 verifier uses. Works in
 *     Node, browser, and Workers without runtime fs access.
 *
 * Only the two public functions consumers actually need (`encode` and
 * `reconstruct`) are exported. The rest is the wbindgen heap-table dance.
 *
 * Encoding:
 *   `encode(dataShards: Uint8Array[], parityShard: number)` → array of
 *   `dataShards.length + parityShard` Uint8Arrays. The first N are the input
 *   shards unchanged; the trailing M are the freshly computed parity shards.
 *   All shards are the same length — caller is responsible for padding the
 *   data into equal-size data shards.
 *
 * Reconstruction:
 *   `reconstruct(corruptedShards, parityShard, deadIndexes)` → fully recovered
 *   array. Pass placeholders (empty Uint8Arrays) at the dead indexes; the
 *   reconstructor fills them in. Up to `parityShard` shards may be missing.
 */

// The bundled-WASM loader lives in its own module so the `.wasm` static import
// is only encountered when the fallback path is actually exercised. Tools
// that can't parse the import (vitest without `vite-plugin-wasm`) can import
// `rs.ts` cleanly so long as callers always pass a pre-compiled
// `WebAssembly.Module` to `initRsWasm`.
//
// `@rollup/plugin-wasm` (with `targetEnv: 'auto-inline'`) actually returns
// the result of `WebAssembly.instantiate(buffer, imports)` — which, when
// called with a `BufferSource`, yields the `{ module, instance }` source
// pair, NOT a bare `WebAssembly.Instance`. The plugin's own typings claim
// the latter; treat the result as `unknown` and unwrap defensively below.
type BundledLoader = (
    imports?: Record<string, Record<string, unknown>>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// wbindgen heap-object table
// ---------------------------------------------------------------------------
//
// wbindgen passes JS values to/from WASM by storing them in this JS-side heap
// and shuttling integer indexes across the boundary. Indexes 0–35 are reserved
// for runtime constants (`undefined`, `null`, `true`, `false`); 36+ are
// recyclable slots.

const heap: unknown[] = new Array(32).fill(undefined);
heap.push(undefined, null, true, false);
let heap_next = heap.length;

function getObject(idx: number): unknown {
    return heap[idx];
}

function dropObject(idx: number): void {
    if (idx < 36) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx: number): unknown {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

function addHeapObject(obj: unknown): number {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx] as number;
    heap[idx] = obj;
    return idx;
}

// ---------------------------------------------------------------------------
// WASM memory views (lazily re-bound when memory.buffer grows on alloc)
// ---------------------------------------------------------------------------

let wasm: WasmExports | null = null;

let cachedUint8: Uint8Array | null = null;
function u8(): Uint8Array {
    if (cachedUint8 === null || cachedUint8.buffer !== wasm!.memory.buffer) {
        cachedUint8 = new Uint8Array(wasm!.memory.buffer);
    }
    return cachedUint8;
}

let cachedUint32: Uint32Array | null = null;
function u32(): Uint32Array {
    if (cachedUint32 === null || cachedUint32.buffer !== wasm!.memory.buffer) {
        cachedUint32 = new Uint32Array(wasm!.memory.buffer);
    }
    return cachedUint32;
}

let cachedInt32: Int32Array | null = null;
function i32(): Int32Array {
    if (cachedInt32 === null || cachedInt32.buffer !== wasm!.memory.buffer) {
        cachedInt32 = new Int32Array(wasm!.memory.buffer);
    }
    return cachedInt32;
}

const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

// ---------------------------------------------------------------------------
// Boundary helpers — moving JS arrays of Uint8Arrays across the FFI
// ---------------------------------------------------------------------------

let WASM_VECTOR_LEN = 0;

/**
 * Allocate `array.length * 4` bytes inside the WASM heap and write each
 * element's heap-table index there as a u32. Used to pass `Uint8Array[]` into
 * Rust — wbindgen reads each index back via the `__wbg_*` import callbacks.
 */
function passArrayJsValueToWasm(array: Uint8Array[], malloc: (n: number) => number): number {
    const ptr = malloc(array.length * 4);
    const mem = u32();
    for (let i = 0; i < array.length; i++) {
        mem[ptr / 4 + i] = addHeapObject(array[i]);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

/**
 * Pull `len` heap-table indexes from WASM memory starting at `ptr`, take each
 * referenced object, and return them as a plain JS array. The take() consumes
 * the heap slot so it can be reused.
 */
function getArrayJsValueFromWasm(ptr: number, len: number): Uint8Array[] {
    const mem = u32();
    const slice = mem.subarray(ptr / 4, ptr / 4 + len);
    const result: Uint8Array[] = [];
    for (let i = 0; i < slice.length; i++) {
        result.push(takeObject(slice[i]) as Uint8Array);
    }
    return result;
}

function getStringFromWasm(ptr: number, len: number): string {
    return textDecoder.decode(u8().subarray(ptr, ptr + len));
}

// ---------------------------------------------------------------------------
// WASM module typings + initialization
// ---------------------------------------------------------------------------

interface WasmExports {
    memory: WebAssembly.Memory;
    encode: (retptr: number, ptr: number, len: number, parity: number) => void;
    reconstruct: (retptr: number, ptr: number, len: number, parity: number, deadIdx: number) => void;
    __wbindgen_add_to_stack_pointer: (n: number) => number;
    __wbindgen_malloc: (n: number) => number;
    __wbindgen_free: (ptr: number, size: number) => void;
}

/**
 * The wbindgen import object — every callback Rust expects from JS. Names are
 * hard-coded by wasm-bindgen based on the Rust function signatures; do not
 * rename. If the upstream package is regenerated, these may drift and need
 * resyncing with the new `wasm_reed_solomon_erasure.js`.
 */
function buildImports(): WebAssembly.Imports {
    const wbindgen: Record<string, (...args: number[]) => number | void> = {
        __wbindgen_object_drop_ref: (arg0: number) => {
            takeObject(arg0);
        },
        __wbg_buffer_7af23f65f6c64548: (arg0: number) => {
            const ret = (getObject(arg0) as Uint8Array).buffer;
            return addHeapObject(ret);
        },
        __wbg_newwithbyteoffsetandlength_ce1e75f0ce5f7974: (arg0: number, arg1: number, arg2: number) => {
            const ret = new Uint8Array(getObject(arg0) as ArrayBuffer, arg1 >>> 0, arg2 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_new_cc9018bd6f283b6f: (arg0: number) => {
            const ret = new Uint8Array(getObject(arg0) as ArrayBuffer);
            return addHeapObject(ret);
        },
        __wbg_set_f25e869e4565d2a2: (arg0: number, arg1: number, arg2: number) => {
            (getObject(arg0) as Uint8Array).set(getObject(arg1) as Uint8Array, arg2 >>> 0);
        },
        __wbg_length_0acb1cf9bbaf8519: (arg0: number) => {
            return (getObject(arg0) as Uint8Array).length;
        },
        __wbg_new_e8c5277c0f9e2cfc: (arg0: number) => {
            const ret = new Uint32Array(getObject(arg0) as ArrayBuffer);
            return addHeapObject(ret);
        },
        __wbg_set_03c7d8c063f469ef: (arg0: number, arg1: number, arg2: number) => {
            (getObject(arg0) as Uint32Array).set(getObject(arg1) as Uint32Array, arg2 >>> 0);
        },
        __wbg_length_f98ca60981480796: (arg0: number) => {
            return (getObject(arg0) as Uint32Array).length;
        },
        __wbindgen_throw: (arg0: number, arg1: number) => {
            throw new Error(getStringFromWasm(arg0, arg1));
        },
        __wbindgen_memory: () => {
            return addHeapObject(wasm!.memory);
        },
    };
    return { __wbindgen_placeholder__: wbindgen as unknown as WebAssembly.ModuleImports };
}

let _readyPromise: Promise<void> | null = null;

/**
 * Load and instantiate the WASM module. Idempotent — repeated calls await the
 * same one-shot promise.
 *
 * Two ways to initialize, matching the pattern used by `workers/groth16-verifier`:
 *   1. `await initRsWasm()` — uses the bundled .wasm (base64-inlined at build
 *      time by `@rollup/plugin-wasm`). Works in any runtime that allows
 *      runtime `WebAssembly.compile()`.
 *   2. `await initRsWasm(myWasmModule)` — accepts a pre-compiled
 *      `WebAssembly.Module`. Useful when the bundled loader path isn't
 *      available (vitest, CF Workers wanting deploy-time precompile, etc.).
 */
export async function initRsWasm(wasmModule?: WebAssembly.Module): Promise<void> {
    if (_readyPromise) return _readyPromise;
    _readyPromise = (async () => {
        const imports = buildImports();
        let instance: WebAssembly.Instance;
        if (wasmModule) {
            // `instantiate(module, imports)` returns a bare Instance.
            instance = await WebAssembly.instantiate(wasmModule, imports);
        } else {
            // Defer the `.wasm` import to a separate module so vitest can load
            // `rs.ts` without it. Production callers either don't pass a
            // module (and hit the bundled loader here) or pass one explicitly.
            const bundled = (await import("./bundled-loader")).default as BundledLoader;
            const result = await bundled(imports as Record<string, Record<string, unknown>>);
            // The bundled loader's actual return type is
            // `{ module: WebAssembly.Module, instance: WebAssembly.Instance }`
            // — the rollup-plugin-wasm shape from `WebAssembly.instantiate(buffer, imports)`.
            // Older versions (or future changes) may return a bare Instance,
            // so accept either shape.
            instance = unwrapInstance(result);
        }
        wasm = instance.exports as unknown as WasmExports;
    })();
    return _readyPromise;
}

/**
 * Normalize the value returned by `WebAssembly.instantiate` / the
 * rollup-plugin-wasm loader into a bare `WebAssembly.Instance`. Handles
 * both the `(module, imports)` overload (returns Instance) and the
 * `(buffer, imports)` overload (returns `{ module, instance }`).
 */
function unwrapInstance(result: unknown): WebAssembly.Instance {
    if (result && typeof result === "object") {
        const candidate = result as { instance?: WebAssembly.Instance; exports?: unknown };
        if (candidate.instance && typeof candidate.instance === "object" && "exports" in candidate.instance) {
            return candidate.instance;
        }
        if ("exports" in candidate) {
            return result as WebAssembly.Instance;
        }
    }
    throw new Error(
        "rs.ts: bundled WASM loader returned an unrecognized shape — expected WebAssembly.Instance or { module, instance }",
    );
}

/**
 * Reset the singleton (test-only escape hatch). Lets a test load a different
 * pre-compiled module without restarting the process. Production code should
 * never need this.
 */
export function _resetRsWasmForTests(): void {
    _readyPromise = null;
    wasm = null;
    cachedUint8 = null;
    cachedUint32 = null;
    cachedInt32 = null;
}

function ensureReady(): void {
    if (!wasm) {
        throw new Error("rs.ts: WASM not initialized. Call `await initRsWasm()` first.");
    }
}

// ---------------------------------------------------------------------------
// Public API — encode + reconstruct
// ---------------------------------------------------------------------------

/**
 * Encode the input data shards with `parityShard` parity shards. All input
 * shards must be Uint8Arrays of equal length; output contains the input shards
 * unchanged plus `parityShard` newly computed parity shards.
 */
export function encode(dataShards: Uint8Array[], parityShard: number): Uint8Array[] {
    ensureReady();
    const w = wasm!;
    try {
        const retptr = w.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayJsValueToWasm(dataShards, w.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        w.encode(retptr, ptr0, len0, parityShard);
        const r0 = i32()[retptr / 4 + 0];
        const r1 = i32()[retptr / 4 + 1];
        const v1 = getArrayJsValueFromWasm(r0, r1).slice();
        w.__wbindgen_free(r0, r1 * 4);
        return v1;
    } finally {
        w.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Reconstruct the original full shard array. `corruptedShards` is the full
 * list (data + parity) with placeholder Uint8Arrays at positions listed in
 * `deadShardIndexes`. Returns the recovered, complete list of shards.
 *
 * Up to `parityShard` shards may be missing; more than that is uncorrectable
 * and the underlying WASM throws.
 */
export function reconstruct(
    corruptedShards: Uint8Array[],
    parityShard: number,
    deadShardIndexes: Uint32Array,
): Uint8Array[] {
    ensureReady();
    const w = wasm!;
    try {
        const retptr = w.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayJsValueToWasm(corruptedShards, w.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        w.reconstruct(retptr, ptr0, len0, parityShard, addHeapObject(deadShardIndexes));
        const r0 = i32()[retptr / 4 + 0];
        const r1 = i32()[retptr / 4 + 1];
        const v1 = getArrayJsValueFromWasm(r0, r1).slice();
        w.__wbindgen_free(r0, r1 * 4);
        return v1;
    } finally {
        w.__wbindgen_add_to_stack_pointer(16);
    }
}
