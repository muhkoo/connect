import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mintKeyCert, verifyKeyCert, type CertSigner } from "../../../src/spaces/trust/chatCert";
import type { ChatKeyCert } from "../../../src/spaces/trust/types";
import { SpaceKeyring } from "../../../src/spaces/SpaceKeyring";
import { SpaceNamespace } from "../../../src/core/namespaces/SpaceNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../../src/core/ChatKeyVault";
import type { WrappedPayload } from "../../../src/crypto/PassphraseWrap";
import { KeyStore } from "../../../src/crypto/KeyStore";
import { testSigner } from "../../core/trust/fakes";

const fx = JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));

describe("ChatKeyCert (design §3.2, §6.10)", () => {
    it("the fixture certificate verifies for 'Bob' (member id lower-cased in the bytes)", async () => {
        const c = fx.keyCert.cert;
        expect(await verifyKeyCert("Bob", c, c.ecdh, c.ecdsa)).toBe(true);
    });
    it("round trip; wrong username, swapped ecdh string and a different ecdsa string all fail", async () => {
        const s = await testSigner();
        const c = await mintKeyCert(s, "alice", "ECDH-JWK-B64URL", "ECDSA-JWK-B64URL");
        expect(await verifyKeyCert("alice", c, "ECDH-JWK-B64URL", "ECDSA-JWK-B64URL")).toBe(true);
        expect(await verifyKeyCert("bob", c, "ECDH-JWK-B64URL", "ECDSA-JWK-B64URL")).toBe(false);
        expect(await verifyKeyCert("alice", c, "OTHER", "ECDSA-JWK-B64URL")).toBe(false);
        expect(await verifyKeyCert("alice", c, "ECDH-JWK-B64URL", "OTHER")).toBe(false);
    });
    it("requestKey posts the certificate over the exact strings it publishes", async () => {
        const posted: unknown[] = [];
        const s = await testSigner();
        const ecdh = "eyJlY2RoIjoxfQ", ecdsa = "eyJlY2RzYSI6MX0";
        const kr = new SpaceKeyring({
            spaceId: "sp", memberId: "alice", identityEcdhPub: ecdh, identityEcdsaPub: ecdsa,
            ownPrivateKey: () => null,
            transport: { postJoinRequest: async (r: unknown) => { posted.push(r); } } as never,
            keyCert: () => mintKeyCert(s, "alice", ecdh, ecdsa),
        });
        await kr.requestKey();
        const req = posted[0] as { keyCert: { ecdh: string; ecdsa: string } };
        expect(req.keyCert.ecdh).toBe(ecdh);
        expect(req.keyCert.ecdsa).toBe(ecdsa);
    });
    it("a certificate that cannot be minted never stops the join, and no provider means no keyCert field", async () => {
        const posted: Record<string, unknown>[] = [];
        const deps = {
            spaceId: "sp", memberId: "alice", identityEcdhPub: "E", identityEcdsaPub: "S",
            ownPrivateKey: () => null,
            transport: { postJoinRequest: async (r: Record<string, unknown>) => { posted.push(r); } } as never,
        };
        await new SpaceKeyring({ ...deps, keyCert: async () => { throw new Error("locked"); } }).requestKey();
        await new SpaceKeyring(deps).requestKey();
        expect(posted).toHaveLength(2);
        for (const r of posted) {
            expect(r.memberId).toBe("alice");
            expect("keyCert" in r).toBe(false);
        }
    });
});

describe("client.space mints one certificate per member and chat keys (design §3.2)", () => {
    afterEach(() => KeyStore.getInstance().forget("alice"));

    type Join = { identityEcdhPub: string; identityEcdsaPub: string; keyCert?: ChatKeyCert };

    function nsWith(signer: CertSigner): { ns: SpaceNamespace; joins: Join[] } {
        const joins: Join[] = [];
        let blob: WrappedPayload | null = null;
        const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
        const fetch = (async (url: string, init?: RequestInit) => {
            if (String(url).endsWith("/keyring/join-request")) joins.push(JSON.parse(String(init!.body)));
            return new Response("{}");
        }) as typeof globalThis.fetch;
        const ns = new SpaceNamespace({
            http: { baseUrl: "http://test", fetch, get: async () => ({}), post: async () => ({}) } as never,
            session: { username: "alice", seed: new Uint8Array(32).fill(7), commitment: "c-alice" } as never,
            wsBaseUrl: "ws://test",
            chatKeys: new ChatKeyVault(store),
            trust: { signer } as never,
        });
        return { ns, joins };
    }

    it("shares one certificate across Spaces, and a failed mint is retried by the next join", async () => {
        const s = await testSigner();
        let signs = 0;
        const signer: CertSigner = {
            identityKeyRaw: () => s.identityKeyRaw(),
            sign: async (b) => {
                if (++signs === 1) throw new Error("directory unreachable");
                return s.sign(b);
            },
        };
        const { ns, joins } = nsWith(signer);
        const one = await ns.get("sp-one");
        const two = await ns.get("sp-two");

        await one.keyring!.requestKey(); // the mint fails: the join still goes out, uncertified
        await two.keyring!.requestKey(); // retried, not the cached failure
        await one.keyring!.requestKey(); // the same certificate, no second signature

        expect(joins.map((j) => "keyCert" in j)).toEqual([false, true, true]);
        expect(signs).toBe(2);
        expect(joins[2].keyCert).toEqual(joins[1].keyCert);
        const j = joins[1];
        expect(await verifyKeyCert("alice", j.keyCert!, j.identityEcdhPub, j.identityEcdsaPub)).toBe(true);
    });
});
