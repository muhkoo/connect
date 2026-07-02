/**
 * Environment probe deciding whether the offline layer turns itself on. Offline
 * support is **on by default in browsers** and a no-op everywhere else, so this
 * is the gate the {@link ../core/Client} consults to pick {@link
 * ./store/IndexedDbStore} vs {@link ./store/NoopStore}.
 *
 * We require all three web APIs the layer leans on — `indexedDB` (structured
 * cache + durable queue), the Cache API (file-shard bytes), and a `window`
 * (so we're in a real document with online/offline events) — and we *touch*
 * them inside a try/catch, because some sandboxed or private-mode contexts
 * expose the globals but throw on use (mirrors `defaultSessionStore`).
 */

export function isOfflineCapable(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            typeof indexedDB !== "undefined" &&
            typeof caches !== "undefined"
        );
    } catch {
        return false;
    }
}
