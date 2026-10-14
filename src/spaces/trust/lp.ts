/**
 * Length-prefixed encoding (SpecA §3.1), the primitive every signed byte string
 * in `src/spaces/trust` is built from:
 *
 *   LP(x) := uint32be(len(x)) ‖ x
 *
 * Usernames carry no charset rule, so bare concatenation would not be
 * injective; every variable field is length-prefixed. A string goes in as the
 * UTF-8 of the exact transmitted string, never a re-encoding of it.
 *
 * Ported unchanged from the accelerator's `src/trust/lp.ts`; the two must stay
 * byte-identical (`tests/fixtures/mlog-v1.json` pins both).
 */
import { utf8Encode } from "../../utilities";

/** uint32be(len) ‖ bytes */
export function lp(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffffffff) throw new Error("lp: field too long");
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

/** lp(utf8(s)) */
export function lpStr(s: string): Uint8Array {
  return lp(utf8Encode(s));
}

/**
 * Canonical decimal of a safe integer: `String(n)`, so "-1", "0", "42" (and
 * -0 is "0"). Throws on a float, NaN, an infinity or an unsafe integer, so no
 * such value can ever reach a signature.
 */
export function dec(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error("dec: not a safe integer");
  return String(n);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
