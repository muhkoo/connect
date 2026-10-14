/**
 * `POST /api/storage/commit` and `/api/storage/release`: take or drop a
 * reference to a manifest's shards.
 *
 * The commit is what meters a file's bytes to the app and reference-counts
 * its shards, so garbage collection keeps them; the release drops that
 * reference. The body is `{ hashes, bytes }` and nothing else. The accelerator
 * keys its reference ledger on the caller, the app, the bytes and the sorted
 * hashes, so this body must not change: a commit sent in another shape would
 * take a second reference instead of finding the first.
 *
 * Shared by `Space` (`putFile`, `commitFile`, `releaseFile`) and by
 * `client.vfs`, which takes and drops references here directly. A reference
 * names only shards and needs no Space; opening the content space to take one
 * created that space for a user who had never written a file, which a
 * paid-only app refuses for a Free user (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, D12).
 *
 * Internal: not re-exported from any barrel.
 */

import type { FileManifest } from "../types";

/**
 * Commit or release `manifest`'s shards through `fetchFn`, which should be
 * `HttpClient.fetchWithRecovery`, so a dead session is re-established once
 * rather than refused three times. Best-effort: tries three times, or once
 * for a 401, then warns and returns, without failing the caller's write.
 */
export async function commitManifest(
    fetchFn: typeof fetch,
    httpBaseUrl: string,
    manifest: FileManifest,
    action: "commit" | "release",
): Promise<void> {
    const hashes = manifest.chunks.flatMap((c) => c.shardHashes);
    if (hashes.length === 0) return;
    const body = JSON.stringify({ hashes, bytes: manifest.size });
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetchFn(`${httpBaseUrl}/api/storage/${action}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body,
            });
            if (res.ok) return;
            // A 401 that `fetchFn`'s recovery could not fix. Another try
            // would only run that recovery again (`auth.zk.recover()`, and
            // `onSessionExpired` for the app) and be refused again.
            if (res.status === 401) break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    // Best-effort: a missed commit leaves the shards to orphan-GC (still not
    // durable-unmetered long-term); a missed release just delays GC. Reconciled
    // by the platform sweep. Don't fail the caller's write on a metering hiccup.
    console.warn(`[muhkoo] storage ${action} did not confirm for ${hashes.length} shard(s)`);
}
