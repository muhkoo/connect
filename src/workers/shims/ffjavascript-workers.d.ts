/**
 * Type declarations for Workers-compatible ffjavascript shim
 */

export function buildBn128(singleThread?: boolean): Promise<any>;

export namespace Scalar {
    function e(value: string | number | bigint): bigint;
    function fromRprLE(buffer: Uint8Array, offset?: number, len?: number): bigint;
    function toRprLE(buffer: Uint8Array, offset: number, value: bigint, len?: number): void;
    function fromRprBE(buffer: Uint8Array, offset?: number, len?: number): bigint;
    function toRprBE(buffer: Uint8Array, offset: number, value: bigint, len?: number): void;
    function toString(value: bigint, radix?: number): string;
    function isZero(value: bigint): boolean;
    function isNegative(value: bigint): boolean;
    function neg(value: bigint): bigint;
    function add(a: bigint, b: bigint): bigint;
    function sub(a: bigint, b: bigint): bigint;
    function mul(a: bigint, b: bigint): bigint;
    function div(a: bigint, b: bigint): bigint;
    function mod(a: bigint, b: bigint): bigint;
    function pow(base: bigint, exp: bigint): bigint;
    function exp(base: bigint, exp: bigint): bigint;
    function abs(value: bigint): bigint;
    function shiftLeft(value: bigint, n: number): bigint;
    function shiftRight(value: bigint, n: number): bigint;
    function band(a: bigint, b: bigint): bigint;
    function bor(a: bigint, b: bigint): bigint;
    function bxor(a: bigint, b: bigint): bigint;
    function bnot(value: bigint): bigint;
    function bits(value: bigint): number;
    function eq(a: bigint, b: bigint): boolean;
    function neq(a: bigint, b: bigint): boolean;
    function lt(a: bigint, b: bigint): boolean;
    function gt(a: bigint, b: bigint): boolean;
    function leq(a: bigint, b: bigint): boolean;
    function geq(a: bigint, b: bigint): boolean;
}

export namespace utils {
    function stringifyBigInts(obj: any): any;
    function unstringifyBigInts(obj: any): any;
    function beBuff2int(buffer: Uint8Array): bigint;
    function beInt2Buff(value: bigint, len?: number): Uint8Array;
    function leBuff2int(buffer: Uint8Array): bigint;
    function leInt2Buff(value: bigint, len?: number): Uint8Array;
}

export class BigBuffer {
    constructor(size: number);
    set(data: Uint8Array, offset?: number): void;
    slice(start?: number, end?: number): Uint8Array;
    get byteLength(): number;
}
