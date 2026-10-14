/**
 * Listing personal-space keys by prefix (accelerator spec
 * 2026-10-03-personal-kv-prefix-list). `client.kv.list`, `client.kv.keys` and
 * the store under `client.vfs`/`client.vcs` send a prefix and follow the
 * server's cursor. All of them still work against a server older than the key
 * index, which ignores the prefix and returns every key with no cursor.
 */
import { describe, it, expect } from "vitest";
import { KvNamespace } from "../../src/core/namespaces/KvNamespace";
import { HttpClient } from "../../src/core/HttpClient";
import { SessionState } from "../../src/core/Session";
import { listPersonalKeys, MAX_SERVER_PREFIX_CHARS, RepeatedCursorError } from "../../src/core/personalList";
import { Client } from "../../src/core/Client";
import type { VfsStore } from "../../src/vfs/types";

const BASE_URL = "http://localhost:8787";
const COMMITMENT = "98765432109876543210";
const KEYS = ["chat-keys", "notes/n1", "todos/t1", "todos/t2", "todos/t3", "vfs/d/root", "vfs/space"];

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

/**
 * A server with the key index: sorted keys, filtered by prefix, `pageSize` per
 * page, and an opaque cursor (`c:<last key>`). Records every /list body.
 */
export function pagedServer(keys: string[], pageSize = 2) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/list")) return json({});
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        bodies.push(body);
        const prefix: string = body.prefix ?? "";
        const after: string | null = typeof body.cursor === "string" ? body.cursor.slice(2) : null;
        const under = [...keys].sort().filter((k) => k.startsWith(prefix) && (after === null || k > after));
        const page = under.slice(0, pageSize);
        return json({ keys: page, cursor: under.length > pageSize ? `c:${page[page.length - 1]}` : null });
    }) as typeof fetch;
    return { fetchFn, bodies };
}

/** A server from before the key index: ignores every field, returns every key, no cursor. */
function oldServer(keys: string[]) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
        return json({ keys });
    }) as typeof fetch;
    return { fetchFn, bodies };
}

async function over(fetchFn: typeof fetch) {
    const session = new SessionState();
    await session.setSession({ token: "t".repeat(64), username: "alice", commitment: COMMITMENT });
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => session.token, fetch: fetchFn });
    return { http, kv: new KvNamespace({ http, session, wsBaseUrl: "ws://localhost:8787" }) };
}

describe("listPersonalKeys", () => {
    it("sends the prefix, then follows each cursor until it is null", async () => {
        const { fetchFn, bodies } = pagedServer(KEYS);
        const { http } = await over(fetchFn);
        expect(await listPersonalKeys(http, "/list", "todos/")).toEqual(["todos/t1", "todos/t2", "todos/t3"]);
        expect(bodies).toEqual([{ prefix: "todos/" }, { prefix: "todos/", cursor: "c:todos/t2" }]);
    });

    it("an empty prefix still asks for paged mode", async () => {
        const { fetchFn, bodies } = pagedServer(KEYS);
        const { http } = await over(fetchFn);
        expect(await listPersonalKeys(http, "/list", "")).toEqual([...KEYS].sort());
        expect(bodies[0]).toEqual({ prefix: "" });
    });

    it("reads an old server's single unfiltered answer as the last page", async () => {
        const { fetchFn, bodies } = oldServer(KEYS);
        const { http } = await over(fetchFn);
        expect(await listPersonalKeys(http, "/list", "todos/")).toEqual(KEYS);
        expect(bodies).toHaveLength(1);
    });

    it("refuses to loop on a cursor the server already gave", async () => {
        const fetchFn = (async () => json({ keys: ["a"], cursor: "same" })) as typeof fetch;
        const { http } = await over(fetchFn);
        const listing = listPersonalKeys(http, "/list", "");
        await expect(listing).rejects.toBeInstanceOf(RepeatedCursorError);
        await expect(listing).rejects.toThrow(/repeated a cursor/);
    });

    it("asks for every key when the prefix is longer than the server accepts, and leaves the filtering to the caller", async () => {
        const { fetchFn, bodies } = pagedServer(KEYS);
        const { http, kv } = await over(fetchFn);
        // Over the cap: the server would answer 400, so ask for everything, as before the key index.
        expect(await listPersonalKeys(http, "/list", "x".repeat(MAX_SERVER_PREFIX_CHARS + 1))).toEqual([...KEYS].sort());
        expect(bodies[0]).toEqual({ prefix: "" });
        // A collection name of 1024 characters is a prefix of 1025 with its "/": still a list, not an error.
        expect(await kv.list("c".repeat(MAX_SERVER_PREFIX_CHARS))).toEqual([]);
        // The cap counts code points: 1024 emoji (2048 UTF-16 units) go to the server as they are.
        bodies.length = 0;
        await listPersonalKeys(http, "/list", "\u{1F600}".repeat(MAX_SERVER_PREFIX_CHARS));
        expect(bodies[0]).toEqual({ prefix: "\u{1F600}".repeat(MAX_SERVER_PREFIX_CHARS) });
    });

    it("treats a null body as no keys", async () => {
        const fetchFn = (async () => json(null)) as typeof fetch;
        const { http } = await over(fetchFn);
        expect(await listPersonalKeys(http, "/list", "x/")).toEqual([]);
    });
});

describe("client.kv.list", () => {
    it("asks the server for the collection's prefix and returns ids across pages", async () => {
        const { fetchFn, bodies } = pagedServer(KEYS);
        const { kv } = await over(fetchFn);
        expect(await kv.list("todos")).toEqual(["t1", "t2", "t3"]);
        expect(bodies.map((b) => b.prefix)).toEqual(["todos/", "todos/"]);
    });

    it("still returns only the collection from a server that ignores the prefix", async () => {
        const { fetchFn } = oldServer(KEYS);
        const { kv } = await over(fetchFn);
        expect(await kv.list("todos")).toEqual(["t1", "t2", "t3"]);
        expect(await kv.list("vfs")).toEqual(["d/root", "space"]);
    });
});

describe("client.kv.keys", () => {
    it("returns full keys under a raw prefix, and every key with none", async () => {
        const { fetchFn } = pagedServer(KEYS);
        const { kv } = await over(fetchFn);
        expect(await kv.keys("vfs/")).toEqual(["vfs/d/root", "vfs/space"]);
        expect(await kv.keys("todos/t")).toEqual(["todos/t1", "todos/t2", "todos/t3"]);
        expect(await kv.keys()).toEqual([...KEYS].sort());
    });

    it("filters an old server's answer to the prefix", async () => {
        const { fetchFn } = oldServer(KEYS);
        const { kv } = await over(fetchFn);
        expect(await kv.keys("notes/")).toEqual(["notes/n1"]);
    });
});

describe("the personal store under client.vfs and client.vcs", () => {
    it("sends the prefix it is given, and an empty one for list(), and follows the cursor", async () => {
        const { fetchFn, bodies } = pagedServer(KEYS);
        const client = new Client({ baseUrl: BASE_URL, fetch: fetchFn, offline: { enabled: false } });
        const session = (client as unknown as { session: SessionState }).session;
        await session.setSession({ token: "t".repeat(64), username: "alice", commitment: COMMITMENT });
        const store = (client.vfs as unknown as { deps: { store: VfsStore } }).deps.store;

        expect(await store.list("todos/")).toEqual(["todos/t1", "todos/t2", "todos/t3"]);
        expect(bodies).toEqual([{ prefix: "todos/" }, { prefix: "todos/", cursor: "c:todos/t2" }]);

        bodies.length = 0;
        expect(await store.list()).toEqual([...KEYS].sort());
        expect(bodies[0]).toEqual({ prefix: "" });
    });
});
