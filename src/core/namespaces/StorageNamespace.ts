/**
 * `client.storage` — per-user persistent storage backed by the accelerator's
 * personal space.
 *
 *   await client.storage.set('todos', id, { title, completed })
 *   const todo = await client.storage.get('todos', id)
 *   const ids  = await client.storage.list('todos')
 *   await client.storage.delete('todos', id)
 *   const off  = client.storage.on('change', e => …)   // realtime, cross-device
 *
 * A *collection* is a key namespace within the user's space; the stored key is
 * `${collection}/${id}`. Operations are authorized by the user's session token
 * (stamped on every request by {@link HttpClient}) — no per-op Groth16 proof.
 *
 * Values are encrypted at rest by default ({@link StorageCipher}, an AES-GCM
 * key derived from the ZK identity); pass `{ encrypt: false }` to store
 * plaintext. The realtime feed rides the personal space's own websocket, so no
 * separate transport is involved.
 *
 * `query()` is intentionally deferred — see the SDK overhaul plan.
 */

import type { HttpClient } from "../HttpClient";
import type { SessionState } from "../Session";
import type { ZkIdentity } from "../../auth/identity";
import { StorageCipher } from "../../crypto/StorageCipher";

export interface StorageNamespaceDeps {
    http: HttpClient;
    session: SessionState;
    /** WebSocket base (ws/wss) for the change feed; derived from baseUrl. */
    wsBaseUrl: string;
}

export interface SetOptions {
    /** Encrypt the value at rest (default: true). */
    encrypt?: boolean;
}

export interface StorageChangeEvent<T = unknown> {
    collection: string;
    id: string;
    type: "set" | "delete";
    /** The decrypted value for `set`; `null` for `delete`. */
    data: T | null;
}

/** Raw change frame pushed by `PersonalSpaceDO`'s websocket. */
interface ChangeFrame {
    _t: "change";
    key: string;
    op: "set" | "delete";
    value?: unknown;
}

export class StorageNamespace {
    private cipher: StorageCipher | null = null;
    private cipherIdentity: ZkIdentity | null = null;

    constructor(private readonly deps: StorageNamespaceDeps) {}

    /** Store `value` under `collection`/`id` (encrypted at rest by default). */
    async set<T = unknown>(collection: string, id: string, value: T, opts?: SetOptions): Promise<void> {
        const encrypt = opts?.encrypt !== false;
        const stored = encrypt ? await this.getCipher().encrypt(value) : value;
        await this.deps.http.post(this.kvPath(collection, id), { value: stored });
    }

    /** Fetch the value at `collection`/`id`, or `null` if absent. */
    async get<T = unknown>(collection: string, id: string): Promise<T | null> {
        const res = await this.deps.http.post<{ value: unknown }>(
            `${this.kvPath(collection, id)}/get`,
            {},
        );
        return this.decode<T>(res.value);
    }

    /** Delete `collection`/`id`. Returns whether the key existed. */
    async delete(collection: string, id: string): Promise<boolean> {
        const res = await this.deps.http.del<{ ok: boolean; existed: boolean }>(
            this.kvPath(collection, id),
            {},
        );
        return Boolean(res.existed);
    }

    /** List the ids present in `collection`. */
    async list(collection: string): Promise<string[]> {
        const res = await this.deps.http.post<{ keys: string[] }>(this.spacePath("/list"), {});
        const prefix = `${collection}/`;
        return (res.keys ?? [])
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length));
    }

    /** Reserved — server-side query is deferred (see the overhaul plan). */
    async query(_collection: string, _filter?: unknown): Promise<never> {
        throw new Error("client.storage.query is not implemented yet (deferred in the SDK overhaul).");
    }

    /**
     * Subscribe to realtime changes to this user's data across devices. Opens
     * the personal space's websocket and decrypts each change before handing
     * it to `handler`. Returns an unsubscribe function.
     *
     * Requires a `WebSocket` global (browsers; Node 22+ or a `ws` shim).
     */
    on<T = unknown>(event: "change", handler: (e: StorageChangeEvent<T>) => void): () => void {
        if (event !== "change") throw new Error(`client.storage: unknown event "${event}"`);

        const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
        if (typeof WS !== "function") {
            throw new Error("client.storage.on: no `WebSocket` global available in this runtime.");
        }
        const token = this.deps.session.token;
        if (!token) throw new Error("client.storage.on: not signed in.");

        const url = `${this.deps.wsBaseUrl}/api/personal/${encodeURIComponent(this.commitment())}/websocket?session=${encodeURIComponent(token)}`;
        const socket = new WS(url);

        socket.addEventListener("message", (ev: MessageEvent) => {
            void this.dispatchChange<T>(ev.data, handler);
        });

        return () => {
            try { socket.close(); } catch { /* already closed */ }
        };
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private async dispatchChange<T>(
        raw: unknown,
        handler: (e: StorageChangeEvent<T>) => void,
    ): Promise<void> {
        let frame: ChangeFrame;
        try {
            frame = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
            return;
        }
        if (!frame || frame._t !== "change" || typeof frame.key !== "string") return;

        const slash = frame.key.indexOf("/");
        if (slash < 0) return;
        const collection = frame.key.slice(0, slash);
        const id = frame.key.slice(slash + 1);

        const data = frame.op === "set" ? await this.decode<T>(frame.value) : null;
        handler({ collection, id, type: frame.op, data });
    }

    /** Decode a stored value: decrypt envelopes, pass plaintext through. */
    private async decode<T>(value: unknown): Promise<T | null> {
        if (value == null) return null;
        if (StorageCipher.isEnvelope(value)) return this.getCipher().decrypt<T>(value);
        return value as T;
    }

    private commitment(): string {
        const c = this.deps.session.commitment;
        if (!c) throw new Error("client.storage: not signed in — call client.auth.zk.login() first.");
        return c;
    }

    private spacePath(suffix: string): string {
        return `/api/personal/${encodeURIComponent(this.commitment())}${suffix}`;
    }

    private kvPath(collection: string, id: string): string {
        const key = `${collection}/${id}`;
        return this.spacePath(`/kv/${encodeURIComponent(key)}`);
    }

    /** The at-rest cipher for the current identity (re-derived if it changes). */
    private getCipher(): StorageCipher {
        const identity = this.deps.session.requireIdentity();
        if (this.cipher && this.cipherIdentity === identity) return this.cipher;
        this.cipher = new StorageCipher(identity.secretHex, identity.saltHex);
        this.cipherIdentity = identity;
        return this.cipher;
    }
}

export default StorageNamespace;
