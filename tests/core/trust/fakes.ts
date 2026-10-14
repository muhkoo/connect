import { toBase64 } from "../../../src/utilities";
import type { IdentitySigner } from "../../../src/core/trust/IdentitySigner";

/** A real P-256 key behind the IdentitySigner interface. */
export async function testSigner(): Promise<IdentitySigner & { kp: CryptoKeyPair }> {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ik = toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    return {
        kp,
        identityKeyRaw: async () => ik,
        sign: async (b) => toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, b))),
    };
}

/**
 * The personal-KV routes the SDK uses for reserved documents (server brief §8;
 * PersonalSpaceDO.hlcLoses is a STRING compare): POST .../kv/<key> {value, hlc}
 * → {ok, applied}; POST .../kv/<key>/get → {key, value, hlc}.
 */
export function fakePersonalKv() {
    const docs = new Map<string, { value: unknown; hlc: string }>();
    const hooks: { beforeGet?: () => Promise<void> | void; beforeSet?: () => Promise<void> | void } = {};
    const http = {
        async post(path: string, body: { value?: unknown; hlc?: string }) {
            const m = /\/kv\/([^/]+)(\/get)?$/.exec(path)!;
            const key = decodeURIComponent(m[1]);
            if (m[2]) {
                await hooks.beforeGet?.();
                const d = docs.get(key);
                return { key, value: d?.value ?? null, hlc: d?.hlc ?? null };
            }
            await hooks.beforeSet?.();
            const cur = docs.get(key);
            if (cur && body.hlc !== undefined && cur.hlc >= body.hlc) return { ok: true, applied: false };
            docs.set(key, { value: body.value, hlc: body.hlc ?? "" });
            return { ok: true, applied: true };
        },
    };
    return { http, docs, hooks };
}
