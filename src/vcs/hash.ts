/**
 * Content addressing for repository objects.
 *
 * The hash must depend only on MEANING, never on serialisation accidents — two
 * clients that build the same tree have to agree on its hash, or history forks
 * for no reason. So keys are sorted and the encoding is fixed here rather than
 * left to `JSON.stringify`'s insertion order.
 */

/** Canonical JSON: object keys sorted, recursively. */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** SHA-256 of an object's canonical form, hex. */
export async function hashObject(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(canonical(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
