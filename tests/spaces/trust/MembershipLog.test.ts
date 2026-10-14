import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { MembershipLog } from "../../../src/spaces/trust/MembershipLog";
import { Chain, user, type TestUser } from "./chainHelper";

let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser;
beforeAll(async () => { [alice, bob, carol, dave] = await Promise.all(["alice", "bob", "carol", "dave"].map(user)); });

const fresh = () => new MembershipLog({ spaceId: "sp1", appId: "app1" });
const roles = (l: MembershipLog) => Object.fromEntries(l.members.map((m) => [m.id, m.role]));

describe("MembershipLog: private rules (design §3.5; server authorizeEntry)", () => {
    it("owner adds an editor; the editor adds a viewer", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(bob, "add", { member: "carol", memberIk: carol.ik, role: "viewer" });
        const l = fresh();
        expect(await l.apply(c.entries)).toEqual({ ok: true });
        expect(roles(l)).toEqual({ alice: "owner", bob: "editor", carol: "viewer" });
        expect(l.member("bob")!.ik).toBe(bob.ik);
    });
    it("editors add viewers only; viewers add no one (no-ops, the chain continues)", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(alice, "add", { member: "carol", memberIk: carol.ik, role: "viewer" });
        await c.push(bob, "add", { member: "dave", memberIk: dave.ik, role: "editor" }); // editor-role
        await c.push(carol, "add", { member: "dave", memberIk: dave.ik, role: "viewer" }); // not-owner
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("dave")).toBe(false);
        expect(l.invalid.map((i) => i.reason)).toEqual(["editor-role", "not-owner"]);
        expect(l.head!.seq).toBe(4);
    });
    it("a demoted editor cannot add", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(alice, "role", { member: "bob", role: "viewer" });
        await c.push(bob, "add", { member: "carol", memberIk: carol.ik, role: "viewer" });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("carol")).toBe(false);
    });
    it("remove rules: an editor cannot remove an editor; the owner can; removal is recorded", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(alice, "add", { member: "carol", memberIk: carol.ik, role: "editor" });
        await c.push(bob, "remove", { member: "carol" }); // target-editor
        await c.push(alice, "remove", { member: "carol" });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("carol")).toBe(false);
        expect(l.invalid.map((i) => i.reason)).toEqual(["target-editor"]);
        expect(l.lastHumanRemovalSeq).toBe(4);
    });
    it("the owner cannot leave; a member can", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        await c.push(alice, "leave", {});
        await c.push(bob, "leave", {});
        const l = fresh();
        await l.apply(c.entries);
        expect(roles(l)).toEqual({ alice: "owner" });
        expect(l.invalid.map((i) => i.reason)).toEqual(["owner-leave"]);
    });
    it("a member signing with an IK other than the one it was added with is a no-op", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(bob, "add", { member: "carol", memberIk: carol.ik, role: "viewer" }, { signAs: dave, ik: dave.ik });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("carol")).toBe(false);
        expect(l.invalid[0].reason).toBe("identity-bound");
    });
    it("a bad signature is a no-op", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" }, { signAs: dave });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("bob")).toBe(false);
        expect(l.invalid[0].reason).toBe("bad-signature");
    });
    it("a broken chain is integrity", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        const e = await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        const l = fresh();
        expect(await l.apply([c.entries[0], { ...e, prev: "AAAA" }])).toEqual({ ok: false, integrity: "chain" });
    });
    it("a genesis for another app is integrity", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice, "someone-elses-app");
        expect(await fresh().apply(c.entries)).toEqual({ ok: false, integrity: "wrong-app" });
    });
    it("ops outside the slice advance the chain and change nothing (slice ruling S11)", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "svc", { member: "__agent__:x", action: "add", ecdhPub: "e", ecdsaPub: "s", mode: "addressed", rosterSeq: 1 });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.head!.seq).toBe(1);
        expect(l.invalid[0].reason).toBe("unsupported-op");
    });
    it("the accelerator fixture's private chain applies, and its head hash matches", async () => {
        const fx = JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));
        const l = new MembershipLog({ spaceId: fx.chains.private.spaceId, appId: "app_fixture01" });
        const entries = fx.chains.private.entries.map((r: { entry: unknown }) => r.entry);
        expect(await l.apply(entries)).toEqual({ ok: true });
        expect(l.head!.hash).toBe(fx.chains.private.entries.at(-1).hash);
    });
});

describe("MembershipLog: genesis, heads and member records (design §3.5, §3.7)", () => {
    const fx = () => JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));

    it("a genesis whose signature does not verify is integrity", async () => {
        const c = new Chain("sp1");
        await c.push(alice, "genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} }, { signAs: dave });
        const l = fresh();
        expect(await l.apply(c.entries)).toEqual({ ok: false, integrity: "genesis" });
        expect(l.head).toBeNull();
        expect(l.owner).toBeNull();
    });
    it("a public genesis marks the log unsupported: it chains, and names no owner and no members", async () => {
        const pub = fx().chains.public;
        const l = new MembershipLog({ spaceId: pub.spaceId, appId: "app_fixture01" });
        expect(await l.apply(pub.entries.map((r: { entry: unknown }) => r.entry))).toEqual({ ok: true });
        expect(l.unsupported).toBe(true);
        expect(l.owner).toBeNull();
        expect(l.members).toEqual([]);
        expect(l.head!.hash).toBe(pub.entries.at(-1).hash);
    });
    it("hashAt gives the hash of every applied entry, the no-ops included", async () => {
        const priv = fx().chains.private;
        const l = new MembershipLog({ spaceId: priv.spaceId, appId: "app_fixture01" });
        await l.apply(priv.entries.map((r: { entry: unknown }) => r.entry));
        priv.entries.forEach((r: { entry: { seq: number }; hash: string }) => expect(l.hashAt(r.entry.seq)).toBe(r.hash));
        expect(l.hashAt(priv.entries.length)).toBeUndefined();
    });
    it("a leave is a human removal; a refused remove is not (the fixture's private chain)", async () => {
        const priv = fx().chains.private;
        const l = new MembershipLog({ spaceId: priv.spaceId, appId: "app_fixture01" });
        await l.apply(priv.entries.map((r: { entry: unknown }) => r.entry));
        expect(l.invalid.find((i) => i.seq === 6)?.reason).toBe("target-not-member");
        expect(l.isMember("bob")).toBe(false);
        expect(l.lastHumanRemovalSeq).toBe(7);
    });
    it("a role change stores a new record; a member record read earlier keeps its role", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        const l = fresh();
        await l.apply(c.entries);
        const before = l.member("bob")!;
        await c.push(alice, "role", { member: "bob", role: "viewer" });
        await l.apply(c.entries.slice(2));
        expect(before.role).toBe("editor");
        expect(l.member("bob")).toEqual({ id: "bob", ik: bob.ik, role: "viewer", since: 1 });
    });
});

describe("MembershipLog: a page that cannot be verified is integrity, never a throw (design §3.7)", () => {
    it("an empty page on a fresh log is integrity: ok always means a genesis was applied", async () => {
        const l = fresh();
        expect(await l.apply([])).toEqual({ ok: false, integrity: "missing-genesis" });
        expect(l.head).toBeNull();
        expect(l.owner).toBeNull();
    });
    it("an empty page after a verified genesis is still ok (an incremental apply with nothing new)", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        const l = fresh();
        await l.apply(c.entries);
        expect(await l.apply([])).toEqual({ ok: true });
        expect(l.head!.seq).toBe(0);
        expect(l.owner).toBe("alice");
    });
    it("an entry the canonical encoding rejects is integrity (malformed), and nothing after it applies", async () => {
        const c = new Chain("sp1");
        const g = await c.genesis(alice);
        const a = await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        const atGenesis: unknown[] = [
            null,
            { ...g, body: null },
            { ...g, body: { ...g.body, legacyCommits: { "01": "x" } } },
        ];
        for (const bad of atGenesis) {
            const l = fresh();
            expect(await l.apply([bad as never, a])).toEqual({ ok: false, integrity: "malformed" });
            expect(l.head).toBeNull();
        }
        const afterGenesis: unknown[] = [
            { ...a, body: null },
            { ...a, at: 1.5 },
            { ...a, op: "frobnicate" },
        ];
        for (const bad of afterGenesis) {
            const l = fresh();
            expect(await l.apply([g, bad as never])).toEqual({ ok: false, integrity: "malformed" });
            expect(l.head!.seq).toBe(0);
            expect(l.isMember("bob")).toBe(false);
        }
    });
});
