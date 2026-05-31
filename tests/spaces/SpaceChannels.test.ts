/**
 * SpaceNamespace channel-registry tests — the app-public name→space-id
 * directory methods, against a mock HttpClient (no sockets). The socket-bound
 * paths (createSpace/joinSpace) are covered by Space.wire.test.ts.
 */

import { describe, it, expect } from "vitest";
import { SpaceNamespace, ChannelNotFoundError } from "../../src/core/namespaces/SpaceNamespace";
import { HttpError } from "../../src/core/HttpClient";

/** Build a SpaceNamespace over a scripted mock HttpClient. */
function nsWith(handlers: {
    get?: (path: string) => unknown;
    post?: (path: string, body?: unknown) => unknown;
}): { ns: SpaceNamespace; posted: Array<{ path: string; body?: unknown }> } {
    const posted: Array<{ path: string; body?: unknown }> = [];
    const http = {
        baseUrl: "http://test",
        fetch: (async () => new Response("{}")) as typeof fetch,
        get: async (path: string) => handlers.get?.(path),
        post: async (path: string, body?: unknown) => {
            posted.push({ path, body });
            return handlers.post?.(path, body);
        },
        del: async () => ({}),
    };
    const ns = new SpaceNamespace({
        http: http as never,
        session: { username: "alice" } as never,
        wsBaseUrl: "ws://test",
    });
    return { ns, posted };
}

describe("SpaceNamespace — channel registry", () => {
    it("listChannels returns the directory entries", async () => {
        const { ns } = nsWith({
            get: () => ({ channels: [{ name: "general", spaceId: "id-A" }, { name: "random", spaceId: "id-B" }] }),
        });
        const channels = await ns.listChannels();
        expect(channels).toEqual([
            { name: "general", spaceId: "id-A" },
            { name: "random", spaceId: "id-B" },
        ]);
    });

    it("listChannels tolerates an empty/absent directory", async () => {
        const { ns } = nsWith({ get: () => ({}) });
        expect(await ns.listChannels()).toEqual([]);
    });

    it("resolveChannel returns the space id when present", async () => {
        const { ns } = nsWith({
            get: (path) => {
                expect(path).toBe("/api/app/channels/general");
                return { spaceId: "id-A" };
            },
        });
        expect(await ns.resolveChannel("general")).toBe("id-A");
    });

    it("resolveChannel returns null on 404", async () => {
        const { ns } = nsWith({
            get: () => { throw new HttpError("not found", 404); },
        });
        expect(await ns.resolveChannel("nope")).toBeNull();
    });

    it("resolveChannel rethrows non-404 errors", async () => {
        const { ns } = nsWith({
            get: () => { throw new HttpError("boom", 500); },
        });
        await expect(ns.resolveChannel("x")).rejects.toThrow(/boom/);
    });

    it("resolveChannel url-encodes the channel name", async () => {
        let seen = "";
        const { ns } = nsWith({ get: (path) => { seen = path; return { spaceId: "id" }; } });
        await ns.resolveChannel("a/b space");
        expect(seen).toBe("/api/app/channels/a%2Fb%20space");
    });

    it("joinChannel throws ChannelNotFoundError when the name is unregistered", async () => {
        const { ns } = nsWith({
            get: () => { throw new HttpError("not found", 404); },
        });
        await expect(ns.joinChannel("ghost")).rejects.toBeInstanceOf(ChannelNotFoundError);
    });
});
