/**
 * `client.kv` — per-user key/value storage backed by the accelerator's personal
 * space.
 *
 *   await client.kv.set('todos', id, { title, completed })
 *   const todo = await client.kv.get('todos', id)
 *   const ids  = await client.kv.list('todos')
 *   await client.kv.delete('todos', id)
 *   const off  = client.kv.on('change', e => …)   // realtime, cross-device
 *
 * A *collection* is a key namespace within the user's space; the stored key is
 * `${collection}/${id}`. Operations are authorized by the user's session token
 * (stamped on every request by {@link HttpClient}) — no per-op Groth16 proof.
 *
 * Values are encrypted at rest by default ({@link StorageCipher}, an AES-GCM
 * key derived from the ZK identity); pass `{ encrypt: false }` to store
 * plaintext. The realtime feed rides the personal space's websocket over a
 * {@link WSTransport} (heartbeat keep-alive + auto-reconnect, event-namespaced
 * so it doesn't cross wires with chat/space transports).
 *
 * For **files** (blobs), use `client.storage` instead — `client.kv` is for
 * small structured values. `query()` is intentionally deferred.
 */

import type { HttpClient } from "../HttpClient";
import type { SessionState } from "../Session";
import type { ZkIdentity } from "../../auth/identity";
import { StorageCipher } from "../../crypto/StorageCipher";
import { WSTransport } from "../../transport/WSTransport";
import { EventCoreEvents } from "../../events";

export interface KvNamespaceDeps {
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

export class KvNamespace {
    private cipher: StorageCipher | null = null;
    private cipherIdentity: ZkIdentity | null = null;

    constructor(private readonly deps: KvNamespaceDeps) {}

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
        throw new Error("client.kv.query is not implemented yet (deferred in the SDK overhaul).");
    }

    /**
     * Subscribe to realtime changes to this user's data across devices. Opens
     * the personal space's websocket and decrypts each change before handing
     * it to `handler`. Returns an unsubscribe function.
     *
     * Requires a `WebSocket` global (browsers; Node 22+ or a `ws` shim).
     */
    on<T = unknown>(event: "change", handler: (e: StorageChangeEvent<T>) => void): () => void {
        if (event !== "change") throw new Error(`client.kv: unknown event "${event}"`);

        if (typeof (globalThis as { WebSocket?: typeof WebSocket }).WebSocket !== "function") {
            throw new Error("client.kv.on: no `WebSocket` global available in this runtime.");
        }
        const token = this.deps.session.token;
        if (!token) throw new Error("client.kv.on: not signed in.");

        const commitment = this.commitment();
        const url = `${this.deps.wsBaseUrl}/api/personal/${encodeURIComponent(commitment)}/websocket?session=${encodeURIComponent(token)}`;

        // Ride a WSTransport rather than a bare socket: it keeps the (otherwise
        // idle) personal-space feed warm with heartbeat pings, auto-reconnects
        // if it drops, and namespaces its events by `id` so this feed never
        // crosses wires with chat/space transports on the shared EventCore bus.
        const transport = new WSTransport({ url, id: `personal:${commitment}` });
        const onMessage = (e: CustomEvent) => {
            void this.dispatchChange<T>(e.detail, handler);
        };
        transport.on(EventCoreEvents.MESSAGE, onMessage);
        // Fire-and-forget: the realtime feed is best-effort, and the transport
        // queues nothing it needs before CONNECTED (server→client only).
        void transport.connect();

        return () => {
            transport.off(EventCoreEvents.MESSAGE, onMessage);
            transport.disconnect();
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
        if (!c) throw new Error("client.kv: not signed in — call client.auth.zk.login() first.");
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

export default KvNamespace;
