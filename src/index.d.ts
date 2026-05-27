export * from './browser';
export * from './crypto';
export * from './events';
export * from './messaging';
export * from './types';
export * from './utilities';
export * from './core';
export * from './sessions';
export * from './transport';
// Workers-only Groth16 verifier. Types are exposed in all builds so consumers
// (e.g. accelerator) see them, but the JS implementation is only present in
// dist/workers/index.js. Calling verifyGroth16/initBn128Wasm from the browser
// or server bundles will fail at runtime — they only work under workerd.
export * from './workers/groth16-verifier';
// PersonalSpaceClient + passphrase wrap helpers (browser + server only —
// excluded from the workers build because snarkjs has Node-only transitive
// deps). Types are exposed everywhere so consumers can reference them.
export * from './personal';

export interface Attribute {
    dataType: string;
    attribute: string;
    value: string | number | boolean | Array<string | boolean | number> | object;
}

export type Tag = string;

export interface FileOptions {
    id?: string,
    name?: string,
    size?: number,
    hash?: string,
    contentType?: string,
    path?: string,
    isArchived?: boolean
    version?: number,
    attributes?: Attribute[];
    tags?: string[]
}

export interface FilesInterface {
    id?: string;
    name: string;
    size: number;
    hash: string;
    contentType: string;
    version: number;
    tags: Tag[];
    attributes: Attribute[];
}
