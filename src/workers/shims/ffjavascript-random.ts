// Cloudflare Workers replacement for ffjavascript/src/random.js
// The upstream module statically imports Node's `crypto`, which Workers cannot resolve.
// This shim provides the same exports backed by Web Crypto (globalThis.crypto).
// @ts-ignore — pure-JS ChaCha from ffjavascript has no Node deps
import ChaCha from '../../../node_modules/ffjavascript/src/chacha.js';

export function getRandomBytes(n: number): Uint8Array {
    const array = new Uint8Array(n);
    globalThis.crypto.getRandomValues(array);
    return array;
}

export function getRandomSeed(): number[] {
    const arr = getRandomBytes(32);
    const arrV = new Uint32Array(arr.buffer);
    const seed: number[] = [];
    for (let i = 0; i < 8; i++) {
        seed.push(arrV[i]);
    }
    return seed;
}

let threadRng: any = null;

export function getThreadRng(): any {
    if (threadRng) return threadRng;
    threadRng = new ChaCha(getRandomSeed());
    return threadRng;
}
