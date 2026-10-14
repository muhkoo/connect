/**
 * The canonical byte strings of the e2e-channels trust layer (spec §6.10).
 * Every signature and every hash is computed over these bytes, and the
 * accelerator builds the same bytes; `tests/fixtures/mlog-v1.json` pins both
 * sides.
 *
 * Rules:
 *   - every field is `LP`'d (`lp.ts`); strings as the UTF-8 of the exact
 *     transmitted string (an `ik` is never normalised before signing);
 *   - integers go through `dec`, so "-1" is valid (the enable intent's seq);
 *   - a hash is never over signature bytes: ECDSA is malleable.
 *
 * Changing any byte here breaks every stored log. It is a new label, not an edit.
 *
 * Ported unchanged from the accelerator's `src/trust/canonical.ts` (the
 * server-only app roster encoder is left out). No npm dependencies (§6.9).
 */
import { toBase64, toBase64Url, utf8Encode } from "../../utilities";
import { concatBytes, dec, lp, lpStr } from "./lp";
import type { ChatKeyCert, EpochCommit, OpAndBody, UnsignedEntry } from "./types";

export const LABEL_CHATKEY = "muhkoo-chatkey-v1";
export const LABEL_MLOG = "muhkoo-mlog-v1";
export const LABEL_EPOCH_COMMIT = "muhkoo-epoch-commit-v1";

const CANONICAL_DEC = /^(0|[1-9]\d*)$/;

/** LP(LABEL_CHATKEY) ‖ LP(lower(memberId)) ‖ LP(ik) ‖ LP(ecdh) ‖ LP(ecdsa) */
export function certBytes(memberId: string, cert: Pick<ChatKeyCert, "ik" | "ecdh" | "ecdsa">): Uint8Array {
  return concatBytes(
    lpStr(LABEL_CHATKEY),
    lpStr(memberId.toLowerCase()),
    lpStr(cert.ik),
    lpStr(cert.ecdh),
    lpStr(cert.ecdsa),
  );
}

/**
 * Over the integer keys in ascending numeric order: LP(dec(e)) ‖ LP(value).
 * `{}` gives no bytes. Throws on a key that is not a canonical decimal
 * ("01", "-1", "1.0") or a value that is not a string.
 */
export function epochMapBytes(map: Record<string, string>): Uint8Array {
  const epochs: number[] = [];
  for (const key of Object.keys(map)) {
    if (!CANONICAL_DEC.test(key)) throw new Error("epochMapBytes: key is not a canonical decimal");
    const e = Number(key);
    if (!Number.isSafeInteger(e)) throw new Error("epochMapBytes: key is not a safe integer");
    if (typeof map[key] !== "string") throw new Error("epochMapBytes: value is not a string");
    epochs.push(e);
  }
  epochs.sort((a, b) => a - b);
  return concatBytes(...epochs.map((e) => concatBytes(lpStr(dec(e)), lpStr(map[dec(e)]))));
}

/** The per-op concatenated LPs of §3.5. `leave` has none. */
export function opBytes(entry: OpAndBody): Uint8Array {
  switch (entry.op) {
    case "genesis": {
      const b = entry.body;
      return concatBytes(
        lpStr(b.visibility),
        lpStr(b.policy),
        lpStr(b.appId),
        lpStr(dec(b.baseEpoch)),
        lp(epochMapBytes(b.legacyCommits)),
      );
    }
    case "add":
      return concatBytes(lpStr(entry.body.member), lpStr(entry.body.memberIk), lpStr(entry.body.role));
    case "role":
      return concatBytes(lpStr(entry.body.member), lpStr(entry.body.role));
    case "remove":
      return lpStr(entry.body.member);
    case "leave":
      return new Uint8Array(0);
    case "join":
      return lpStr(entry.body.via);
    case "link": {
      const b = entry.body;
      return concatBytes(
        lpStr(b.linkId),
        lpStr(b.role),
        lpStr(b.standing ? "1" : "0"),
        lpStr(dec(b.expiresAt)),
        lpStr(dec(b.maxUses)),
        lpStr(b.linkEcdhPub),
        lpStr(b.linkSignPub),
        lp(epochMapBytes(b.keyCommits)),
      );
    }
    case "unlink":
      return lpStr(entry.body.linkId);
    case "redeem":
      return lpStr(entry.body.linkId);
    case "svc": {
      const b = entry.body;
      return concatBytes(
        lpStr(b.member),
        lpStr(b.action),
        lpStr(b.ecdhPub),
        lpStr(b.ecdsaPub),
        lpStr(b.mode),
        lpStr(dec(b.rosterSeq)),
      );
    }
    case "retire":
      return concatBytes(lpStr(entry.body.member), lpStr(entry.body.reason));
    default: {
      const unknownOp: never = entry;
      throw new Error(`opBytes: unknown op ${String((unknownOp as { op?: unknown }).op)}`);
    }
  }
}

/** LP(LABEL_MLOG) ‖ LP(spaceId) ‖ LP(dec(seq)) ‖ LP(prev) ‖ LP(op) ‖ LP(by) ‖ LP(ik) ‖ LP(dec(at)) ‖ LP(opBytes). seq −1 is valid (enable intent). */
export function entryBytes(entry: UnsignedEntry): Uint8Array {
  return concatBytes(
    lpStr(LABEL_MLOG),
    lpStr(entry.spaceId),
    lpStr(dec(entry.seq)),
    lpStr(entry.prev),
    lpStr(entry.op),
    lpStr(entry.by),
    lpStr(entry.ik),
    lpStr(dec(entry.at)),
    lp(opBytes(entry)),
  );
}

/** SHA-256 over bytes (WebCrypto). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** b64 (standard, padded) of SHA-256(entryBytes). Never over `sig` or `lsig`. */
export async function entryHash(entry: UnsignedEntry): Promise<string> {
  return toBase64(await sha256(entryBytes(entry)));
}

/** LP(LABEL_EPOCH_COMMIT) ‖ LP(spaceId) ‖ LP(dec(epoch)) ‖ LP(dec(prevKeyed)) ‖ LP(keyCommit) ‖ LP(dec(headSeq)) ‖ LP(headHash) ‖ LP(sole?"1":"0") ‖ LP(by) ‖ LP(ik) ‖ LP(dec(at)) */
export function ecBytes(ec: Omit<EpochCommit, "sig">): Uint8Array {
  return concatBytes(
    lpStr(LABEL_EPOCH_COMMIT),
    lpStr(ec.spaceId),
    lpStr(dec(ec.epoch)),
    lpStr(dec(ec.prevKeyed)),
    lpStr(ec.keyCommit),
    lpStr(dec(ec.headSeq)),
    lpStr(ec.headHash),
    lpStr(ec.sole ? "1" : "0"),
    lpStr(ec.by),
    lpStr(ec.ik),
    lpStr(dec(ec.at)),
  );
}

/**
 * keyCommit(e, K) := b64url_nopad(HKDF-SHA256(ikm = K, salt = utf8("epoch:" + e),
 * info = utf8("muhkoo/space/key-commit/v1\n" + spaceId), L = 32)) (design §4.2.4).
 * The same function as accelerator/scripts/gen-mlog-fixture.mjs `keyCommit`.
 */
export async function keyCommit(epoch: number, key: Uint8Array, spaceId: string): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", key as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8Encode(`epoch:${dec(epoch)}`),
      info: utf8Encode(`muhkoo/space/key-commit/v1\n${spaceId}`),
    },
    ikm,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}
