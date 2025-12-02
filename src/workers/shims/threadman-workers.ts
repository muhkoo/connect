/**
 * Cloudflare Workers-compatible threadman replacement
 * Uses pre-compiled WASM instance instead of WebAssembly.compile()
 */

// @ts-ignore
import thread from '../../../node_modules/ffjavascript/src/threadman_thread.js';

const MEM_SIZE = 25; // Memory size in 64K pages (1600Kb)

class ThreadManager {
    memory: WebAssembly.Memory;
    u8: Uint8Array;
    u32: Uint32Array;
    instance: any;
    singleThread: boolean;
    initalPFree: number;
    pq: number;
    pr: number;
    pG1gen: number;
    pG1zero: number;
    pG2gen: number;
    pG2zero: number;
    pOneT: number;
    taskManager: any;
    concurrency: number;
    code: any;

    constructor() {
        this.memory = null as any;
        this.u8 = null as any;
        this.u32 = null as any;
        this.instance = null;
        this.singleThread = true;
        this.initalPFree = 0;
        this.pq = 0;
        this.pr = 0;
        this.pG1gen = 0;
        this.pG1zero = 0;
        this.pG2gen = 0;
        this.pG2zero = 0;
        this.pOneT = 0;
        this.taskManager = null;
        this.concurrency = 1;
        this.code = null;
    }
}

/**
 * Build thread manager using pre-compiled WASM instance
 * This version accepts an already-instantiated WASM module
 */
export default async function buildThreadManager(wasm: any, singleThread: boolean = true): Promise<ThreadManager> {
    const tm = new ThreadManager();

    // Check if we already have an instance (Workers path)
    if (wasm.instance) {
        tm.memory = wasm.memory;
        tm.instance = wasm.instance;
    } else {
        // Fallback for non-Workers environments
        tm.memory = new WebAssembly.Memory({ initial: MEM_SIZE });
        // @ts-ignore
        const wasmModule = await WebAssembly.compile(wasm.code);
        // @ts-ignore
        tm.instance = await WebAssembly.instantiate(wasmModule, {
            env: { memory: tm.memory }
        });
    }

    tm.u8 = new Uint8Array(tm.memory.buffer);
    tm.u32 = new Uint32Array(tm.memory.buffer);

    tm.singleThread = true; // Always single-threaded in Workers
    tm.initalPFree = tm.u32[0];
    tm.pq = wasm.pq;
    tm.pr = wasm.pr;
    tm.pG1gen = wasm.pG1gen;
    tm.pG1zero = wasm.pG1zero;
    tm.pG2gen = wasm.pG2gen;
    tm.pG2zero = wasm.pG2zero;
    tm.pOneT = wasm.pOneT;

    // Always use single-threaded mode in Workers
    tm.code = wasm.code;
    tm.taskManager = thread();

    // Initialize with our memory
    await tm.taskManager([{
        cmd: "INIT",
        init: MEM_SIZE,
        code: new Uint8Array(0) // Empty code since we already have instance
    }]);
    tm.concurrency = 1;

    return tm;
}
