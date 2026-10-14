/**
 * Listing the keys of a personal space: `POST /api/personal/:commitment/list`
 * in paged mode, followed to the last page.
 *
 * The server answers keys under `prefix` a page at a time, from its key index:
 * `{ keys, cursor }`, with `cursor` null on the last page. A server older than
 * the index ignores `prefix` and answers `{ keys }` with EVERY key and no
 * cursor. That reads as the last page, so this can return more than was asked
 * for, and every caller filters by its prefix itself.
 */
import type { HttpClient } from "./HttpClient";

interface ListPage {
    keys?: string[];
    cursor?: string | null;
}

/** The server's cap on `prefix`, in code points (accelerator `personalKv/list.ts`). */
export const MAX_SERVER_PREFIX_CHARS = 1024;

/**
 * The server handed back a cursor it had already given, so following it would
 * page forever. A fault in the answer, not a failure to reach the server: the
 * offline layer rethrows it instead of falling back to its cache.
 */
export class RepeatedCursorError extends Error {
    constructor() {
        super("personal-space list: the server repeated a cursor; stopping instead of looping");
        this.name = "RepeatedCursorError";
    }
}

/** Every key under `prefix` ("" = every key), in the server's order. */
export async function listPersonalKeys(http: HttpClient, path: string, prefix: string): Promise<string[]> {
    // A prefix over the server's cap would be refused with a 400. Every list
    // was whole before the key index, so ask for everything instead; the
    // caller filters. (`length` first: code points never outnumber units.)
    const sent = prefix.length > MAX_SERVER_PREFIX_CHARS && [...prefix].length > MAX_SERVER_PREFIX_CHARS ? "" : prefix;
    const keys: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
        const res: ListPage | null = await http.post<ListPage | null>(
            path,
            cursor === null ? { prefix: sent } : { prefix: sent, cursor },
        );
        keys.push(...(res?.keys ?? []));
        // Annotated: without it TypeScript infers `next` through `cursor` and
        // the request body above, a loop it reports as TS7022.
        const next: string | null = typeof res?.cursor === "string" && res.cursor !== "" ? res.cursor : null;
        if (next === null) return keys;
        // A server (or a cache in front of one) that hands back a cursor it
        // already gave would have this page forever.
        if (seen.has(next)) throw new RepeatedCursorError();
        seen.add(next);
        cursor = next;
    }
}
