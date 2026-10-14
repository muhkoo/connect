/**
 * `client.vfs` takes and drops references without the content space (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, D12). Taking a reference (`writeManifest`, `retainManifest`,
 * a checkout, Cloud Drive's move of pre-VFS files) and dropping one (a delete) name only shards, so they
 * need no Space. Before, they opened the content space, and created it for a user who had never written
 * a VFS file. On a paid-only app that creation is a write the gate refuses for a Free user, so Cloud
 * Drive's migration failed for them, and so did a permanent delete's release.
 */
import { describe, it, expect, vi } from "vitest";
import { Client } from "../../src/core/Client";
import { SessionState } from "../../src/core/Session";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { HttpClient } from "../../src/core/HttpClient";
import type { FileManifest } from "../../src/storage/types";

const BASE_URL = "http://test";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The accelerator's personal KV in a map, plus every other route answering `{ ok: true }`. `requests`
 * lists `METHOD /path` for every request; `bodies` holds each storage commit or release body.
 */
function accelerator() {
    const kv = new Map<string, unknown>();
    const requests: string[] = [];
    const bodies: Array<{ action: string; body: unknown }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url.pathname}`);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const key = url.pathname.match(/^\/api\/personal\/[^/]+\/kv\/([^/]+)(\/get)?$/);
        if (key) {
            const name = decodeURIComponent(key[1]);
            if (key[2]) return json({ key: name, value: kv.get(name) ?? null });
            if (method === "DELETE") return json({ ok: true, existed: kv.delete(name) });
            kv.set(name, body.value);
            return json({ ok: true });
        }
        if (/^\/api\/personal\/[^/]+\/list$/.test(url.pathname)) {
            const prefix: string = body.prefix ?? "";
            return json({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort(), cursor: null });
        }
        const storage = url.pathname.match(/^\/api\/storage\/(commit|release)$/);
        if (storage) bodies.push({ action: storage[1], body });
        return json({ ok: true, dedup: false });
    }) as typeof fetch;
    return { kv, requests, bodies, fetchFn };
}

/** A signed-in, unlocked Client over `fetchFn`. */
async function signedIn(fetchFn: typeof fetch): Promise<Client> {
    const client = new Client({ baseUrl: BASE_URL, apiKey: "mk_test_pk_x", fetch: fetchFn, offline: { enabled: false } });
    const session = (client as unknown as { session: SessionState }).session;
    await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
    session.setSeed(new Uint8Array(32).fill(3));
    return client;
}

/** A real manifest, as an earlier upload left it: written through a files-only Space over a server that accepts it. */
async function uploadedManifest(): Promise<FileManifest> {
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: (async () => json({ ok: true, dedup: false })) as typeof fetch });
    const ns = new SpaceNamespace({ http, session: { username: "alice", seed: null, commitment: "c-alice", token: "tok" } as never, wsBaseUrl: "ws://test" });
    const space = await ns.get("earlier-space", "static", { messaging: false });
    return (await space.putFile(new Uint8Array([104, 105]), { name: "old.txt", type: "text/plain" })).manifest;
}

const spaceRequests = (requests: string[]) => requests.filter((r) => r.includes("/api/spaces"));
const hashesOf = (m: FileManifest) => m.chunks.flatMap((c) => c.shardHashes);

describe("client.vfs — references without the content space", () => {
    it("writeManifest takes its reference without creating the content space", async () => {
        const server = accelerator();
        const client = await signedIn(server.fetchFn);
        const manifest = await uploadedManifest();

        await client.vfs.writeManifest("/Drive/old.txt", manifest, manifest.size);

        expect(spaceRequests(server.requests)).toEqual([]);
        expect(server.kv.has("vfs/space")).toBe(false);
        expect(server.bodies).toEqual([{ action: "commit", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
        expect((await client.vfs.statManifest("/Drive/old.txt")).manifest).toEqual(manifest);
    });

    it("retainManifest takes its reference without creating the content space", async () => {
        const server = accelerator();
        const client = await signedIn(server.fetchFn);
        const manifest = await uploadedManifest();

        await client.vfs.retainManifest(manifest);

        expect(spaceRequests(server.requests)).toEqual([]);
        expect(server.kv.has("vfs/space")).toBe(false);
        expect(server.bodies).toEqual([{ action: "commit", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
    });

    it("a delete lets go of its file without creating the content space", async () => {
        // The file's record is there, as a migration or an earlier version left it, but no content space
        // is: a fresh Client, so nothing about a space is cached in it.
        const server = accelerator();
        const manifest = await uploadedManifest();
        await (await signedIn(server.fetchFn)).vfs.writeManifest("/Drive/old.txt", manifest, manifest.size);
        server.kv.delete("vfs/space");
        server.requests.length = 0;
        server.bodies.length = 0;
        const client = await signedIn(server.fetchFn);

        await client.vfs.delete("/Drive/old.txt");

        expect(spaceRequests(server.requests)).toEqual([]);
        expect(server.kv.has("vfs/space")).toBe(false);
        expect(server.bodies).toEqual([{ action: "release", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
    });

    it("takes a reference through a stale session by re-establishing it once", async () => {
        const server = accelerator();
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const stale = new Headers(init?.headers).get("X-Muhkoo-Session") !== "fresh";
            if (stale && String(input).endsWith("/api/storage/commit")) return json({ error: "A signed-in session is required" }, 401);
            return server.fetchFn(input, init);
        }) as typeof fetch;
        const client = await signedIn(fetchFn);
        const session = (client as unknown as { session: SessionState }).session;
        const recover = vi.spyOn(client.auth.zk, "recover").mockImplementation(async () => {
            await session.setSession({ token: "fresh", username: "alice", commitment: "c-alice" });
            return true;
        });
        const manifest = await uploadedManifest();

        await client.vfs.retainManifest(manifest);

        expect(recover).toHaveBeenCalledTimes(1);
        expect(server.bodies).toEqual([{ action: "commit", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
    });

    it("the first write of new bytes still creates the content space, once", async () => {
        // A guard: it passes before and after this change, which must not move the space's creation.
        const server = accelerator();
        const client = await signedIn(server.fetchFn);

        await client.vfs.writeFile("/Drive/a.txt", "hello");
        await client.vfs.writeFile("/Drive/b.txt", "world");

        const created = server.requests.filter((r) => /^POST \/api\/spaces\/[^/]+\/metadata$/.test(r));
        expect(created).toHaveLength(1);
        expect(typeof server.kv.get("vfs/space")).toBe("string");
        expect(server.bodies.map((b) => b.action)).toEqual(["commit", "commit"]);
    });
});
