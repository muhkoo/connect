import type { SessionState } from "../Session";
import { deriveIdentityFromSeed } from "../../auth/identity";
import { exportPublicKeyBase64 } from "../../auth/keys";
import { ikEquals } from "../../spaces/trust/ik";
import { toBase64 } from "../../utilities";
import { IdentityLockedError } from "./errors";
import type { IdentityDirectory } from "./IdentityDirectory";

/** Signs with the account identity key (IK). Never exposes the seed (SpecA §6.1). */
export interface IdentitySigner {
    /** b64 IEEE-P1363 ECDSA-P256-SHA256 over `bytes`. */
    sign(bytes: Uint8Array): Promise<string>;
    /** The IK as standard padded base64 of the raw 65-byte point. */
    identityKeyRaw(): Promise<string>;
}

/**
 * Derives the IK from the in-memory seed (HKDF(seed,"ecdsa-priv"), non-extractable),
 * and checks it against the account's registered IK before its first use, because
 * `unlockWithSeed`/`unlockWithDevice` set a seed without a commitment check.
 * Locked or mismatched → IdentityLockedError.
 */
export class SeedIdentitySigner implements IdentitySigner {
    private cached: { seed: Uint8Array; priv: CryptoKey; ik: string } | null = null;

    constructor(private readonly deps: { session: SessionState; directory: Pick<IdentityDirectory, "lookup"> }) {}

    private async key(): Promise<{ priv: CryptoKey; ik: string }> {
        const { session } = this.deps;
        const seed = session.seed;
        const username = session.username;
        if (!seed || !username) throw new IdentityLockedError();
        if (this.cached && this.cached.seed === seed) return this.cached;
        const identity = session.identity ?? (await deriveIdentityFromSeed(seed));
        const ik = await exportPublicKeyBase64(identity.ecdsaKeyPair.publicKey);
        const registered = await this.deps.directory.lookup(username);
        if (!ikEquals(registered, ik)) {
            throw new IdentityLockedError("This session's key is not your account's registered identity. Sign in again.");
        }
        this.cached = { seed, priv: identity.ecdsaKeyPair.privateKey, ik };
        return this.cached;
    }

    async identityKeyRaw(): Promise<string> {
        return (await this.key()).ik;
    }

    async sign(bytes: Uint8Array): Promise<string> {
        const { priv } = await this.key();
        return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, bytes as BufferSource)));
    }
}
