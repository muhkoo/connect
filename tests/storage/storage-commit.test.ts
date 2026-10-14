/**
 * `POST /api/storage/commit` and `/release` (accelerator spec 2026-10-06-paid-accounts-and-past-due, B8
 * and the D12 mechanism). One helper sends them for `Space` and for `client.vfs`. Its body is a wire
 * contract: the accelerator keys its reference ledger on it, so a commit sent in another shape would take
 * a second reference instead of finding the first.
 */
import { describe, it, expect, vi } from "vitest";
import { HttpClient } from "../../src/core/HttpClient";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { commitManifest } from "../../src/storage/transport/storageCommit";
import type { FileManifest } from "../../src/storage/types";

const BASE_URL = "http://test";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MANIFEST = {
    id: "m1",
    name: "a.txt",
    size: 5,
    type: "text/plain",
    lastModified: 0,
    createdAt: 0,
    version: 1,
    chunks: [
        { shardHashes: ["h1", "h2"] },
        { shardHashes: ["h3"] },
    ],
} as unknown as FileManifest;

describe("commitManifest — the wire", () => {
    it.each(["commit", "release"] as const)("POSTs /api/storage/%s with { hashes, bytes } and nothing else", async (action) => {
        const sent: Array<{ url: string; method?: string; body: unknown }> = [];
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            sent.push({ url: String(input), method: init?.method, body: init?.body });
            return json({ ok: true });
        }) as typeof fetch;

        await commitManifest(fetchFn, BASE_URL, MANIFEST, action);

        expect(sent).toEqual([
            { url: `${BASE_URL}/api/storage/${action}`, method: "POST", body: '{"hashes":["h1","h2","h3"],"bytes":5}' },
        ]);
    });

    it("sends nothing for a manifest with no shards", async () => {
        const fetchFn = vi.fn(async () => json({ ok: true }));
        await commitManifest(fetchFn as never, BASE_URL, { ...MANIFEST, chunks: [] } as FileManifest, "commit");
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe("Space — a commit or release with a stale session", () => {
    /** Shard PUTs are accepted with any session, as today; commit and release refuse the stale one with 401. */
    function staleCommits() {
        const session = { username: "alice", seed: new Uint8Array(32).fill(7), commitment: "c-alice", token: "stale" };
        const commits: Array<{ action: string; token: string | null }> = [];
        const onUnauthorized = vi.fn(async () => {
            session.token = "fresh";
            return true;
        });
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const token = new Headers(init?.headers).get("X-Muhkoo-Session");
            const action = url.match(/\/api\/storage\/(commit|release)$/)?.[1];
            if (action) {
                commits.push({ action, token });
                if (token !== "fresh") return json({ error: "A signed-in session is required" }, 401);
            }
            return json({ ok: true, dedup: false });
        }) as typeof fetch;
        const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => session.token, fetch: fetchFn, onUnauthorized });
        const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        return { ns, commits, onUnauthorized };
    }

    it("re-establishes the session once and commits a new file, without the three blind retries", async () => {
        const { ns, commits, onUnauthorized } = staleCommits();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const space = await ns.get("space-files", "static", { messaging: false });
            await space.putFile(new Uint8Array([1, 2, 3, 4]), { name: "a.bin", type: "application/octet-stream" });
            expect(commits).toEqual([
                { action: "commit", token: "stale" },
                { action: "commit", token: "fresh" },
            ]);
            expect(onUnauthorized).toHaveBeenCalledTimes(1);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("re-establishes the session once and releases a file", async () => {
        const { ns, commits } = staleCommits();
        const space = await ns.get("space-files", "static", { messaging: false });
        await space.releaseFile(MANIFEST);
        expect(commits).toEqual([
            { action: "release", token: "stale" },
            { action: "release", token: "fresh" },
        ]);
    });

    it("gives up after one 401 that re-establishing the session did not fix", async () => {
        // Each further try would ask for a new session again, and tell the app again that it expired.
        const { ns, commits, onUnauthorized } = staleCommits();
        onUnauthorized.mockImplementation(async () => false);   // the session cannot be re-established
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const space = await ns.get("space-files", "static", { messaging: false });
            await space.releaseFile(MANIFEST);
            expect(commits).toEqual([{ action: "release", token: "stale" }]);
            expect(onUnauthorized).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});
