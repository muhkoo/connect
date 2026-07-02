/**
 * `ChatKeyVault` — SDK-owned lifecycle for a member's long-lived ratchet/space
 * keypair (the connect `KeyStore` entry keyed by the member id / username).
 *
 * Historically each app hand-rolled this (see the web app's old
 * `personal/spaceLoader.ts`): generate a keypair at register, seed-wrap it, and
 * PUT it to the personal space; on login GET + unwrap + hydrate the `KeyStore`.
 * That scaffolding now lives here so ANY app gets a **stable** member keypair
 * across reloads for free — without which the member re-admits to every space on
 * every load and the group-key cache can never round-trip.
 *
 * Security invariant: the wrapping secret is the **master seed** (not the
 * password), so the blob survives password changes and unlocks under a passkey.
 * The seed is only ever held in memory (never persisted), so this vault can only
 * provision/rehydrate while the client is unlocked.
 */

import { KeyStore } from "../crypto/KeyStore";
import { wrapWithPassphrase, unwrapWithPassphrase, type WrappedPayload } from "../crypto/PassphraseWrap";

/** Staging-only diagnostics: is the member keypair stable across reloads? */
const VAULT_DEBUG = (() => {
    try {
        return typeof location !== "undefined" && /(^|\.)staging\./.test(location.hostname);
    } catch {
        return false;
    }
})();
function vlog(msg: string): void {
    if (VAULT_DEBUG) console.info(`[muhkoo:vault] ${msg}`);
}
/** A short, stable fingerprint of the member's current keypair (ecdsa pub). */
async function fingerprint(memberId: string): Promise<string> {
    try {
        const raw = await KeyStore.getInstance().getRawEcdsaPublicKey(memberId);
        if (!raw) return "none";
        let s = 0;
        for (const b of raw) s = (s * 31 + b) >>> 0;
        return s.toString(16).padStart(8, "0");
    } catch {
        return "err";
    }
}

/** Opaque personal-space blob store (a `PersonalSpaceClient` or a kv-backed shim). */
export interface ChatKeyStore {
    get(key: string): Promise<WrappedPayload | null>;
    put(key: string, value: WrappedPayload): Promise<void>;
}

/** Personal-space key holding the seed-wrapped, dehydrated ratchet keypair. */
export const CHAT_KEYS_KEY = "chat-keys";

export class ChatKeyVault {
    constructor(private readonly store: ChatKeyStore) {}

    /**
     * Register-time: ensure a keypair exists for `memberId`, seed-wrap the
     * dehydrated form, and persist it to the personal space. Idempotent — reuses
     * an existing in-tab keypair rather than minting a second one.
     */
    async provision(memberId: string, seedSecret: string): Promise<void> {
        const ks = KeyStore.getInstance();
        if (!ks.getKeyPair(memberId)) {
            try {
                await ks.generateOwnKeyPair(memberId);
            } catch (e) {
                if (!String((e as Error)?.message ?? e).includes("already exists")) throw e;
            }
        }
        const dehydrated = await ks.dehydrateKeyPair(memberId);
        const plaintext = new TextEncoder().encode(JSON.stringify(dehydrated));
        await this.store.put(CHAT_KEYS_KEY, await wrapWithPassphrase(seedSecret, plaintext));
        vlog(`provision: minted+persisted keypair fp=${await fingerprint(memberId)}`);
    }

    /**
     * Sign-in / unlock time: fetch the wrapped blob, unwrap with the seed, and
     * hydrate the `KeyStore` — restoring the SAME keypair the member had before.
     * Returns `true` when a keypair is now in hand (already present or hydrated),
     * `false` when there's no blob yet (a brand-new member → caller provisions).
     * Throws only on a genuine unwrap failure (wrong secret / tampered blob).
     */
    async rehydrate(memberId: string, seedSecret: string): Promise<boolean> {
        // Already unlocked in this tab — nothing to do.
        if (KeyStore.getInstance().getKeyPair(memberId)?.privateKey) return true;
        const wrapped = await this.store.get(CHAT_KEYS_KEY);
        if (!wrapped) {
            vlog("rehydrate: no chat-keys blob (new member → will provision)");
            return false;
        }
        const bytes = await unwrapWithPassphrase(seedSecret, wrapped);
        const dehydrated = JSON.parse(new TextDecoder().decode(bytes));
        await KeyStore.getInstance().hydrateKeyPair(memberId, dehydrated);
        vlog(`rehydrate: HIT — restored stable keypair fp=${await fingerprint(memberId)}`);
        return true;
    }

    /**
     * Ensure a stable keypair is in hand: rehydrate from the vault if a blob
     * exists, otherwise mint one and persist it (so it's stable next session).
     * Used at register and lazily when a space is first opened.
     */
    async ensure(memberId: string, seedSecret: string): Promise<void> {
        if (await this.rehydrate(memberId, seedSecret)) return;
        await this.provision(memberId, seedSecret);
    }
}

export default ChatKeyVault;
