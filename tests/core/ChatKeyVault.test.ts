import { describe, it, expect, beforeEach } from "vitest";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { KeyStore } from "../../src/crypto/KeyStore";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";

/** In-memory personal-space blob store. */
function memStore(): ChatKeyStore & { blob: WrappedPayload | null } {
    return {
        blob: null,
        async get() {
            return this.blob;
        },
        async put(_key, value) {
            this.blob = value;
        },
    };
}

/** Fresh KeyStore singleton per test (it's a process-global map). */
function resetKeyStore(id: string): void {
    const ks = KeyStore.getInstance();
    ks.keys.delete(id);
    ks.authKeys.delete(id);
}

describe("ChatKeyVault", () => {
    const seed = "c2VlZC1zZWNyZXQtMTIz"; // base64-ish, any non-empty passphrase
    const memberId = "alice";

    beforeEach(() => resetKeyStore(memberId));

    it("provision persists a seed-wrapped blob, rehydrate restores the SAME keypair", async () => {
        const store = memStore();
        const vault = new ChatKeyVault(store);

        // First session: provision generates + persists.
        await vault.provision(memberId, seed);
        expect(store.blob).not.toBeNull();
        const firstPub = await KeyStore.getInstance().getRawEcdsaPublicKey(memberId);
        expect(firstPub).not.toBeNull();

        // Next session: KeyStore is empty; rehydrate must restore the same keypair.
        resetKeyStore(memberId);
        expect(KeyStore.getInstance().getKeyPair(memberId)).toBeNull();
        const ok = await vault.rehydrate(memberId, seed);
        expect(ok).toBe(true);
        const restoredPub = await KeyStore.getInstance().getRawEcdsaPublicKey(memberId);
        expect(Array.from(restoredPub!)).toEqual(Array.from(firstPub!));
    });

    it("rehydrate returns false when no blob exists (new member)", async () => {
        const vault = new ChatKeyVault(memStore());
        expect(await vault.rehydrate(memberId, seed)).toBe(false);
    });

    it("rehydrate throws on the wrong seed (tampered / mismatched)", async () => {
        const store = memStore();
        await new ChatKeyVault(store).provision(memberId, seed);
        resetKeyStore(memberId);
        await expect(new ChatKeyVault(store).rehydrate(memberId, "d3Jvbmctc2VlZA")).rejects.toBeTruthy();
    });

    it("ensure provisions on first use, then rehydrates on the next session", async () => {
        const store = memStore();
        await new ChatKeyVault(store).ensure(memberId, seed); // no blob → provision
        expect(store.blob).not.toBeNull();
        const pub = await KeyStore.getInstance().getRawEcdsaPublicKey(memberId);

        resetKeyStore(memberId);
        await new ChatKeyVault(store).ensure(memberId, seed); // blob → rehydrate
        const pub2 = await KeyStore.getInstance().getRawEcdsaPublicKey(memberId);
        expect(Array.from(pub2!)).toEqual(Array.from(pub!));
    });
});
