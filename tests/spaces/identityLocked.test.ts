import { describe, it, expect, beforeEach, vi } from "vitest";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { KeyStore } from "../../src/crypto/KeyStore";
import { IdentityLockedError, IdentityUnavailableError } from "../../src/core/trust/errors";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";
import { toBase64 } from "../../src/utilities";

const ME = "alice";

function memVault(): { vault: ChatKeyVault; blob: () => WrappedPayload | null; puts: () => number } {
    let blob: WrappedPayload | null = null;
    let puts = 0;
    const store: ChatKeyStore = {
        async get() { return blob; },
        async put(_k, v) { blob = v; puts++; },
    };
    return { vault: new ChatKeyVault(store), blob: () => blob, puts: () => puts };
}

function nsWith(opts: { seed: Uint8Array | null; chatKeys?: ChatKeyVault }): SpaceNamespace {
    const http = {
        baseUrl: "http://test",
        fetch: (async () => new Response("{}")) as typeof fetch,
        get: async () => ({}),
        post: async () => ({}),
        del: async () => ({}),
    };
    return new SpaceNamespace({
        http: http as never,
        session: { username: ME, seed: opts.seed, commitment: "c-alice" } as never,
        wsBaseUrl: "ws://test",
        chatKeys: opts.chatKeys,
    });
}

const ensure = (ns: SpaceNamespace) =>
    (ns as unknown as { ensureIdentity(m: string): Promise<{ ecdhPub: string; ecdsaPub: string }> }).ensureIdentity(ME);
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));
const rejection = (p: Promise<unknown>) =>
    p.then(
        () => { throw new Error("expected a rejection"); },
        (e: unknown) => e as IdentityUnavailableError,
    );

describe("ensureIdentity never takes part with a throwaway key (design §3.3, G10)", () => {
    beforeEach(() => KeyStore.getInstance().forget(ME));

    it("a locked session throws IdentityLockedError and mints nothing", async () => {
        await expect(ensure(nsWith({ seed: null, chatKeys: memVault().vault }))).rejects.toBeInstanceOf(IdentityLockedError);
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("a vault failure throws IdentityUnavailableError and mints nothing", async () => {
        const broken: ChatKeyStore = {
            async get() { throw new Error("503"); },
            async put() { throw new Error("503"); },
        };
        await expect(ensure(nsWith({ seed: new Uint8Array(32).fill(7), chatKeys: new ChatKeyVault(broken) })))
            .rejects.toBeInstanceOf(IdentityUnavailableError);
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("no vault configured throws IdentityUnavailableError", async () => {
        await expect(ensure(nsWith({ seed: new Uint8Array(32).fill(7) }))).rejects.toBeInstanceOf(IdentityUnavailableError);
    });

    it("a vault 5xx is retryable, and a client with no vault is not (design §9.2 I8)", async () => {
        const broken: ChatKeyStore = {
            async get() { throw new Error("503"); },
            async put() { throw new Error("503"); },
        };
        const down = await rejection(ensure(nsWith({ seed: new Uint8Array(32).fill(7), chatKeys: new ChatKeyVault(broken) })));
        expect(down).toBeInstanceOf(IdentityUnavailableError);
        expect(down.retryable).toBe(true);
        expect(down.message).toMatch(/try again/i);

        const none = await rejection(ensure(nsWith({ seed: new Uint8Array(32).fill(7) })));
        expect(none).toBeInstanceOf(IdentityUnavailableError);
        expect(none.retryable).toBe(false);
    });

    it("saved chat keys that will not unwrap under this seed are not retryable, and are never replaced (design §9.2 I8)", async () => {
        const ks = KeyStore.getInstance();

        // Saved under another seed, with a pair minted while locked in the tab.
        const other = memVault();
        await other.vault.provision(ME, toBase64(new Uint8Array(32).fill(1)));
        ks.forget(ME);
        await ks.generateOwnKeyPair(ME);
        const minted = await ks.dehydrateKeyPair(ME);
        const wrongSeed = await rejection(ensure(nsWith({ seed: new Uint8Array(32).fill(2), chatKeys: other.vault })));
        expect(wrongSeed).toBeInstanceOf(IdentityUnavailableError);
        expect(wrongSeed.retryable).toBe(false);
        expect(wrongSeed.message).not.toMatch(/try again/i);
        // Nothing in the KeyStore changes before the saved pair imports: the minted pair stays, and never takes part.
        expect(await ks.dehydrateKeyPair(ME)).toEqual(minted);
        expect(ks.isVaultBacked(ME)).toBe(false);
        expect(other.puts()).toBe(1);

        // Saved under this seed, but damaged in storage.
        const seed = new Uint8Array(32).fill(4);
        const damaged = memVault();
        await damaged.vault.provision(ME, toBase64(seed));
        ks.forget(ME);
        const b = damaged.blob()!;
        const ct = Buffer.from(b.ciphertext, "base64");
        ct[0] ^= 1;
        b.ciphertext = ct.toString("base64");
        const tampered = await rejection(ensure(nsWith({ seed, chatKeys: damaged.vault })));
        expect(tampered).toBeInstanceOf(IdentityUnavailableError);
        expect(tampered.retryable).toBe(false);
        expect(ks.getKeyPair(ME)).toBeNull();
        expect(damaged.puts()).toBe(1);
    });

    it("a pair minted while locked is replaced by the vault pair after unlock, and is never persisted", async () => {
        const ks = KeyStore.getInstance();
        await ks.generateOwnKeyPair(ME); // e.g. a DM subscription opened while locked (EncryptedSession)
        const ephemeral = await ks.getRawEcdsaPublicKey(ME);
        const seed = new Uint8Array(32).fill(9);
        const { vault, blob } = memVault();

        await ensure(nsWith({ seed, chatKeys: vault }));

        const stable = await ks.getRawEcdsaPublicKey(ME);
        expect(same(stable, ephemeral)).toBe(false);
        expect(ks.isVaultBacked(ME)).toBe(true);
        expect(blob()).not.toBeNull();
        // What was persisted is the stable pair, not the ephemeral one.
        ks.forget(ME);
        expect(await vault.rehydrate(ME, toBase64(seed))).toBe(true);
        expect(same(await ks.getRawEcdsaPublicKey(ME), stable)).toBe(true);
    });

    it("a returning member's saved pair wins over a pair minted while locked (design §3.3)", async () => {
        const ks = KeyStore.getInstance();
        const seed = new Uint8Array(32).fill(5);
        const { vault, puts } = memVault();
        await vault.provision(ME, toBase64(seed)); // an earlier session saved this pair
        const saved = await ks.dehydrateKeyPair(ME);
        ks.forget(ME); // the tab reloads
        await ks.generateOwnKeyPair(ME); // a DM subscription opened while locked (EncryptedSession)
        const ephemeral = await ks.getRawEcdsaPublicKey(ME);
        expect(ks.isVaultBacked(ME)).toBe(false);

        await ensure(nsWith({ seed, chatKeys: vault }));

        // Both halves of both keys are the saved ones: hydrating never overwrites a
        // pair that holds a private key, so the minted pair must be dropped first.
        expect(same(await ks.getRawEcdsaPublicKey(ME), ephemeral)).toBe(false);
        expect(await ks.dehydrateKeyPair(ME)).toEqual(saved);
        expect(ks.isVaultBacked(ME)).toBe(true);
        expect(puts()).toBe(1);
    });

    it("provision never persists a foreign in-tab pair", async () => {
        const ks = KeyStore.getInstance();
        await ks.generateOwnKeyPair(ME);
        const foreign = await ks.getRawEcdsaPublicKey(ME);
        const { vault } = memVault();
        await vault.provision(ME, "seed-secret");
        expect(same(await ks.getRawEcdsaPublicKey(ME), foreign)).toBe(false);
        expect(ks.isVaultBacked(ME)).toBe(true);
    });

    it("a pair minted while the saved pair is being fetched is replaced by it, never marked (Review Focus 1)", async () => {
        const ks = KeyStore.getInstance();
        const seed = new Uint8Array(32).fill(6);
        const { vault, blob } = memVault();
        await vault.provision(ME, toBase64(seed)); // an earlier session saved this pair
        const saved = await ks.dehydrateKeyPair(ME);
        const savedIdentity = await ensure(nsWith({ seed, chatKeys: vault }));
        ks.forget(ME); // the tab reloads

        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        let reads = 0;
        const slow: ChatKeyStore = {
            async get() { reads++; await held; return blob(); },
            async put() { throw new Error("nothing is persisted here"); },
        };
        const pending = ensure(nsWith({ seed, chatKeys: new ChatKeyVault(slow) }));
        await vi.waitFor(() => expect(reads).toBe(1));
        await ks.generateOwnKeyPair(ME); // a DM subscription connects while the saved pair is in flight
        release();

        expect(await pending).toEqual(savedIdentity);
        expect(await ks.dehydrateKeyPair(ME)).toEqual(saved);
        expect(ks.isVaultBacked(ME)).toBe(true);
    });

    it("a mint that finishes after the saved pair is swapped in leaves it unmarked, and the next open swaps it back (Review Focus 1)", async () => {
        const ks = KeyStore.getInstance();
        const seed = new Uint8Array(32).fill(8);
        const { vault } = memVault();
        await vault.provision(ME, toBase64(seed));
        const saved = await ks.dehydrateKeyPair(ME);
        ks.forget(ME);

        // Hold a DM's mint between its ECDH half and its ECDSA half, across the swap.
        const generate = crypto.subtle.generateKey.bind(crypto.subtle);
        let releaseMint!: () => void;
        const mintHeld = new Promise<void>((r) => { releaseMint = r; });
        const spy = vi.spyOn(crypto.subtle, "generateKey").mockImplementation((async (alg: AlgorithmIdentifier, ext: boolean, uses: KeyUsage[]) => {
            if ((alg as { name?: string }).name === "ECDSA") await mintHeld;
            return generate(alg as EcKeyGenParams, ext, uses);
        }) as never);
        try {
            const minting = ks.generateOwnKeyPair(ME);
            await vi.waitFor(() => expect(ks.getKeyPair(ME)).not.toBeNull());

            await ensure(nsWith({ seed, chatKeys: vault }));
            expect(await ks.dehydrateKeyPair(ME)).toEqual(saved);
            releaseMint();
            await minting; // the mint's ECDSA half lands over the saved pair

            expect(ks.isVaultBacked(ME)).toBe(false);
            await ensure(nsWith({ seed, chatKeys: vault }));
            expect(await ks.dehydrateKeyPair(ME)).toEqual(saved);
            expect(ks.isVaultBacked(ME)).toBe(true);
        } finally {
            releaseMint();
            spy.mockRestore();
        }
    });

    it("provision generates, persists, then swaps: a failed persist marks nothing and leaves the tab's pair alone", async () => {
        const ks = KeyStore.getInstance();
        await ks.generateOwnKeyPair(ME); // a live DM's pair
        const before = await ks.dehydrateKeyPair(ME);
        const failing = new ChatKeyVault({
            async get() { return null; },
            async put() { throw new Error("503"); },
        });

        await expect(failing.provision(ME, "seed-secret")).rejects.toThrow("503");

        expect(ks.isVaultBacked(ME)).toBe(false);
        expect(await ks.dehydrateKeyPair(ME)).toEqual(before);
    });

    it("two concurrent first opens persist exactly one pair, the one in hand (design §3.3)", async () => {
        const ks = KeyStore.getInstance();
        const seed = new Uint8Array(32).fill(3);
        const { vault, puts } = memVault();
        const ns = nsWith({ seed, chatKeys: vault });

        const [a, b] = await Promise.all([ensure(ns), ensure(ns)]);

        expect(b).toEqual(a);
        expect(puts()).toBe(1);
        expect(ks.isVaultBacked(ME)).toBe(true);
        // The vault blob holds the very pair both calls returned (ECDH and ECDSA alike).
        ks.forget(ME);
        expect(await vault.rehydrate(ME, toBase64(seed))).toBe(true);
        expect(await ensure(ns)).toEqual(a);
        expect(puts()).toBe(1);
    });
});
