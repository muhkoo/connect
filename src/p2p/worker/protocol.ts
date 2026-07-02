/**
 * Bitswap-lite wire protocol for peer block exchange. Four frame types over a
 * {@link ../transport/PeerTransport} data channel:
 *
 *   WANT(hash)         — "does anyone have this block?" / "send it to me"
 *   HAVE(hash)         — "I hold this block" (announce / reply to a WANT)
 *   BLOCK(hash, bytes) — the block itself (verified by hash on receipt)
 *   CANCEL(hash)       — "stop, I got it elsewhere"
 *
 * Frames are compact binary so a 4 MiB shard isn't base64-bloated through JSON:
 *
 *   byte 0      : type (0 WANT | 1 HAVE | 2 BLOCK | 3 CANCEL)
 *   bytes 1..33 : 32-byte raw SHA-256 of the block (our shard hash, hex-decoded)
 *   bytes 33..  : payload (BLOCK only)
 *
 * Blocks are AES-GCM ciphertext, so a frame carries nothing readable; the hash
 * is the capability check (the receiver re-hashes the payload and drops a
 * mismatch). See {@link ./blockEngine}.
 */

export enum FrameType {
    WANT = 0,
    HAVE = 1,
    BLOCK = 2,
    CANCEL = 3,
}

export interface DecodedFrame {
    type: FrameType;
    /** Lowercase hex SHA-256 (matches `shardHash`). */
    hash: string;
    /** Present only for {@link FrameType.BLOCK}. */
    payload?: Uint8Array;
}

const HASH_BYTES = 32;
const HEADER = 1 + HASH_BYTES; // type + hash

function hexToBytes(hex: string): Uint8Array {
    if (hex.length !== HASH_BYTES * 2) {
        throw new Error(`protocol: expected a ${HASH_BYTES}-byte hex hash, got ${hex.length / 2} bytes`);
    }
    const out = new Uint8Array(HASH_BYTES);
    for (let i = 0; i < HASH_BYTES; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
    return s;
}

function header(type: FrameType, hash: string, extra = 0): { buf: Uint8Array; offset: number } {
    const buf = new Uint8Array(HEADER + extra);
    buf[0] = type;
    buf.set(hexToBytes(hash), 1);
    return { buf, offset: HEADER };
}

export function encodeWant(hash: string): Uint8Array {
    return header(FrameType.WANT, hash).buf;
}

export function encodeHave(hash: string): Uint8Array {
    return header(FrameType.HAVE, hash).buf;
}

export function encodeCancel(hash: string): Uint8Array {
    return header(FrameType.CANCEL, hash).buf;
}

export function encodeBlock(hash: string, payload: Uint8Array): Uint8Array {
    const { buf, offset } = header(FrameType.BLOCK, hash, payload.length);
    buf.set(payload, offset);
    return buf;
}

export function decode(frame: Uint8Array): DecodedFrame {
    if (frame.length < HEADER) throw new Error("protocol: frame too short");
    const type = frame[0] as FrameType;
    const hash = bytesToHex(frame.subarray(1, HEADER));
    if (type === FrameType.BLOCK) {
        // Copy the payload out so it doesn't alias a transferred/pooled buffer.
        return { type, hash, payload: frame.slice(HEADER) };
    }
    return { type, hash };
}
