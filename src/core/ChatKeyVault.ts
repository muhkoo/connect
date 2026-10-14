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

/**
 * The saved blob was read but does not unwrap, parse or import under this
 * seed: it is damaged, or was saved under another seed. Unlike a store
 * failure, retrying with the same seed fails the same way (design §9.2 I8).
 */
export class ChatKeysUnreadableError extends Error {
    constructor(readonly reason: unknown) {
        super("The saved chat keys do not unwrap under this seed.");
        this.name = "ChatKeysUnreadableError";
    }
}

export class ChatKeyVault {
    constructor(private readonly store: ChatKeyStore) {}

    /**
     * Register-time: ensure a vault-backed keypair exists for `memberId`,
     * seed-wrap it and persist it. Idempotent for a pair that is already
     * vault-backed. Otherwise a fresh pair is generated, persisted, and only
     * then swapped in, replacing whatever the tab held: a throwaway key is never
     * persisted as the stable one, and a failed persist leaves the tab's keys
     * as they were, with nothing marked.
     */
    async provision(memberId: string, seedSecret: string): Promise<void> {
        const ks = KeyStore.getInstance();
        const fresh = ks.isVaultBacked(memberId) ? null : await ks.generateKeyPair();
        const dehydrated = fresh ? await ks.exportKeyPair(fresh) : await ks.dehydrateKeyPair(memberId);
        const plaintext = new TextEncoder().encode(JSON.stringify(dehydrated));
        await this.store.put(CHAT_KEYS_KEY, await wrapWithPassphrase(seedSecret, plaintext));
        if (fresh) ks.replaceOwnKeyPair(memberId, fresh);
        vlog(`provision: minted+persisted keypair fp=${await fingerprint(memberId)}`);
    }

    /**
     * Sign-in / unlock time: fetch the wrapped blob, unwrap it with the seed, and
     * hydrate the `KeyStore`, restoring the SAME keypair the member had before.
     * Returns `true` when a vault-backed keypair is now in hand, and `false` when
     * there is no blob yet (a brand-new member; the caller provisions). A store
     * failure propagates as thrown; a blob that does not unwrap, parse or import
     * throws `ChatKeysUnreadableError`. Nothing in the `KeyStore` changes until
     * the saved pair is imported; it then replaces whatever pair the tab held,
     * in one step, so a pair minted meanwhile is never kept in its place.
     */
    async rehydrate(memberId: string, seedSecret: string): Promise<boolean> {
        const ks = KeyStore.getInstance();
        if (ks.isVaultBacked(memberId)) return true;
        const wrapped = await this.store.get(CHAT_KEYS_KEY);
        if (!wrapped) {
            vlog("rehydrate: no chat-keys blob (new member → will provision)");
            return false;
        }
        ks.replaceOwnKeyPair(memberId, await this.unwrapPair(seedSecret, wrapped));
        vlog(`rehydrate: HIT — restored stable keypair fp=${await fingerprint(memberId)}`);
        return true;
    }

    /** Unwrap, parse and import a saved pair, outside the `KeyStore`. */
    private async unwrapPair(seedSecret: string, wrapped: WrappedPayload) {
        try {
            const bytes = await unwrapWithPassphrase(seedSecret, wrapped);
            return await KeyStore.getInstance().importKeyPair(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            throw new ChatKeysUnreadableError(e);
        }
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
