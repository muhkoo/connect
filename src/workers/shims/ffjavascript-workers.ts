/**
 * Cloudflare Workers-compatible replacement for ffjavascript
 * Uses pre-compiled WASM with direct instantiation (no WebAssembly.compile)
 */

// @ts-ignore - rollup-plugin-wasm wraps this as a loader function
import loadBn128Wasm from '../wasm/bn128.wasm';
import { bn128Config, q, r, cofactorG2 } from '../wasm/bn128-config';

// Re-export utilities from ffjavascript (these don't use WASM compilation)
// @ts-ignore
export * as Scalar from '../../../node_modules/ffjavascript/src/scalar.js';
// @ts-ignore
export * as utils from '../../../node_modules/ffjavascript/src/utils.js';
// @ts-ignore
export { default as BigBuffer } from '../../../node_modules/ffjavascript/src/bigbuffer.js';

// Cache the curve globally (matches @zk-kit/groth16 behavior)
declare global {
    var curve_bn128: any;
}
globalThis.curve_bn128 = null;

const MEM_SIZE = 25; // 25 * 64KB = 1.6MB

/**
 * Simple thread manager that works with pre-instantiated WASM
 */
class SimpleThreadManager {
    memory: WebAssembly.Memory;
    u8: Uint8Array;
    u32: Uint32Array;
    instance: WebAssembly.Instance;
    exports: any;
    singleThread = true;
    concurrency = 1;
    initalPFree: number;

    // Curve pointers
    pq: number;
    pr: number;
    pG1gen: number;
    pG1zero: number;
    pG2gen: number;
    pG2zero: number;
    pOneT: number;

    constructor(memory: WebAssembly.Memory, instance: WebAssembly.Instance, config: typeof bn128Config) {
        this.memory = memory;
        this.instance = instance;
        this.exports = instance.exports;
        this.u8 = new Uint8Array(memory.buffer);
        this.u32 = new Uint32Array(memory.buffer);
        this.initalPFree = this.u32[0];

        // Copy config pointers
        this.pq = config.pq;
        this.pr = config.pr;
        this.pG1gen = config.pG1gen;
        this.pG1zero = config.pG1zero;
        this.pG2gen = config.pG2gen;
        this.pG2zero = config.pG2zero;
        this.pOneT = config.pOneT;
    }

    alloc(length: number): number {
        while (this.u32[0] & 3) this.u32[0]++;
        const res = this.u32[0];
        this.u32[0] += length;
        return res;
    }

    set(pointer: number, data: Uint8Array, offset = 0): void {
        this.u8.set(data, pointer + offset);
    }

    get(pointer: number, length: number): Uint8Array {
        return this.u8.slice(pointer, pointer + length);
    }

    // Synchronous task execution (single-threaded)
    async queueAction(actionId: number, fnName: string, params: any[], transfers: any[]): Promise<any> {
        const fn = this.exports[fnName];
        if (!fn) {
            throw new Error(`Function ${fnName} not found in WASM exports`);
        }
        return fn(...params);
    }

    resetMemory(): void {
        this.u32[0] = this.initalPFree;
    }

    async terminate(): Promise<void> {
        // Nothing to clean up in single-threaded mode
    }
}

/**
 * Build bn128 curve using pre-compiled WASM module
 * Replaces ffjavascript's buildBn128 which uses WebAssembly.compile()
 */
export async function buildBn128(singleThread = true): Promise<any> {
    // Return cached curve if available
    if (globalThis.curve_bn128) {
        return globalThis.curve_bn128;
    }

    // Create memory for WASM
    const memory = new WebAssembly.Memory({ initial: MEM_SIZE, maximum: 32767 });

    // loadBn128Wasm is a function from @rollup/plugin-wasm that returns WebAssemblyInstantiatedSource
    // When we pass imports, it uses WebAssembly.instantiate (not compile)
    const wasmResult = await (loadBn128Wasm as (imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>)({
        env: { memory }
    });

    // Create our simple thread manager with the instance
    const tm = new SimpleThreadManager(memory, wasmResult, bn128Config);

    // Import curve building components
    // @ts-ignore
    const WasmField1 = (await import('../../../node_modules/ffjavascript/src/wasm_field1.js')).default;
    // @ts-ignore
    const WasmField2 = (await import('../../../node_modules/ffjavascript/src/wasm_field2.js')).default;
    // @ts-ignore
    const WasmField3 = (await import('../../../node_modules/ffjavascript/src/wasm_field3.js')).default;
    // @ts-ignore
    const WasmCurve = (await import('../../../node_modules/ffjavascript/src/wasm_curve.js')).default;
    // @ts-ignore
    const { default: buildPairing } = await import('../../../node_modules/ffjavascript/src/engine_pairing.js');
    // @ts-ignore
    const { default: buildMultiExp } = await import('../../../node_modules/ffjavascript/src/engine_multiexp.js');
    // @ts-ignore
    const { default: buildFFT } = await import('../../../node_modules/ffjavascript/src/engine_fft.js');
    // @ts-ignore
    const { default: buildBatchApplyKey } = await import('../../../node_modules/ffjavascript/src/engine_applykey.js');
    // @ts-ignore
    const Scalar = (await import('../../../node_modules/ffjavascript/src/scalar.js'));

    // Build the curve object
    const curve: any = {};

    curve.q = Scalar.e(q.toString());
    curve.r = Scalar.e(r.toString());
    curve.name = "bn128";
    curve.tm = tm;
    curve.prePSize = bn128Config.prePSize;
    curve.preQSize = bn128Config.preQSize;

    curve.Fr = new WasmField1(tm, "frm", bn128Config.n8r, r);
    curve.F1 = new WasmField1(tm, "f1m", bn128Config.n8q, q);
    curve.F2 = new WasmField2(tm, "f2m", curve.F1);
    curve.G1 = new WasmCurve(tm, "g1m", curve.F1, bn128Config.pG1gen, bn128Config.pG1b, undefined);
    curve.G2 = new WasmCurve(tm, "g2m", curve.F2, bn128Config.pG2gen, bn128Config.pG2b, cofactorG2);
    curve.F6 = new WasmField3(tm, "f6m", curve.F2);
    curve.F12 = new WasmField2(tm, "ftm", curve.F6);
    curve.Gt = curve.F12;

    buildBatchApplyKey(curve, "G1");
    buildBatchApplyKey(curve, "G2");
    buildBatchApplyKey(curve, "Fr");

    buildMultiExp(curve, "G1");
    buildMultiExp(curve, "G2");

    buildFFT(curve, "G1");
    buildFFT(curve, "G2");
    buildFFT(curve, "Fr");

    buildPairing(curve);

    curve.array2buffer = function(arr: any[], sG: number) {
        const buff = new Uint8Array(sG * arr.length);
        for (let i = 0; i < arr.length; i++) {
            buff.set(arr[i], i * sG);
        }
        return buff;
    };

    curve.buffer2array = function(buff: Uint8Array, sG: number) {
        const n = buff.byteLength / sG;
        const arr = new Array(n);
        for (let i = 0; i < n; i++) {
            arr[i] = buff.slice(i * sG, i * sG + sG);
        }
        return arr;
    };

    curve.terminate = async function() {
        globalThis.curve_bn128 = null;
    };

    // Cache the curve
    globalThis.curve_bn128 = curve;

    return curve;
}
