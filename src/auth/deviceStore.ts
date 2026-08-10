/**
 * `deviceStore` — at-rest persistence for a paired device (the TV).
 *
 * A device that has completed {@link HostedAuth.startDevicePairing} holds the
 * account's **master seed**. Android WebView has no WebAuthn, so the passkey
 * wrapping used elsewhere isn't available, and re-pairing on every cold start
 * is not acceptable UX for a set-top box. So the seed is persisted, encrypted:
 *
 * | Item                     | Where                                | Form |
 * | ------------------------ | ------------------------------------ | ---- |
 * | wrapping key             | IndexedDB (`muhkoo.device.v1`)       | `CryptoKey`, AES-GCM-256, **non-extractable** |
 * | device identity keypair  | IndexedDB (`muhkoo.device.v1`)       | `CryptoKeyPair`, ECDSA P-256, private half **non-extractable** |
 * | sealed identity blob     | localStorage `muhkoo.tv.identity.v1` | `{"v":1,"iv":…,"ct":…}` over `JSON{username, commitment, seed(b64), pairedAt}` |
 *
 * The split is deliberate — ciphertext in one backend, key in another, and the
 * key non-extractable so JS can *use* it but not export it.
 *
 * ## Be honest about what this is worth
 *
 * **This is obfuscation, not protection.** It raises the cost of a casual
 * `localStorage` dump to "nothing useful", and that is all:
 *
 *   - **XSS on the device origin** cannot *exfiltrate* the wrapping key (it is
 *     non-extractable) but can absolutely call `decrypt` and read the seed. The
 *     only mitigation is that there is no third-party script in the shell —
 *     enforce a strict CSP with no `unsafe-inline`, no CDN, no remote fonts.
 *   - **ADB / root / a backup extraction / a forensic image recovers the seed.**
 *     The IndexedDB LevelDB files hold the AES key bytes in the clear; WebCrypto
 *     "non-extractable" is a JS-API boundary, not an OS one. **A stolen device is
 *     a stolen identity.**
 *
 * That is not an implementation shortcut, it is the shape of the problem: any
 * wrapping key usable without user interaction lives somewhere equally readable
 * on a keyboard-less device with no hardware key store exposed to WebView.
 * Reduce the blast radius with `android:allowBackup="false"`,
 * `android:debuggable="false"`, a strict CSP, and by storing *only* the 32-byte
 * seed + username + commitment (never a session token, never a recovery phrase).
 *
 * ## Documented upgrade path — no protocol change
 *
 * If the native shell exposes a Keystore bridge:
 *
 * ```java
 * @JavascriptInterface public String wrap(String b64plain);    // AES-GCM, StrongBox when present
 * @JavascriptInterface public String unwrap(String b64cipher);
 * ```
 *
 * this module prefers `globalThis.MuhkooKeystore` automatically and falls back
 * to the WebCrypto scheme otherwise. The Keystore key is hardware-backed and
 * non-exportable at the OS level, so a copied filesystem image alone becomes
 * useless. Nothing on the wire, in the endpoint contracts, or in the SDK surface
 * changes — only the two functions below do, internally.
 *
 * ## Degradation
 *
 * Nothing here throws at import time. On a runtime with neither backend (SSR,
 * Workers, Node) the module still loads: {@link loadDeviceIdentity} returns
 * `null`, {@link persistDeviceIdentity} throws a typed
 * {@link DeviceStoreUnavailableError} the caller can swallow, and
 * {@link deviceIdentityKey} falls back to an **in-memory** keypair for the
 * lifetime of the process (so pairing still works; the device is just never
 * recognised as "known" on a later run).
 */

import { toBase64, fromBase64 } from "./vault";

const TE = new TextEncoder();
const TD = new TextDecoder();

/** localStorage key holding the AES-GCM-sealed identity blob. */
export const DEVICE_IDENTITY_STORAGE_KEY = "muhkoo.tv.identity.v1";
/** IndexedDB database holding the non-extractable keys. */
export const DEVICE_KEY_DB_NAME = "muhkoo.device.v1";
const DEVICE_KEY_STORE = "keys";
const WRAP_KEY_ID = "wrap";
const IDENTITY_KEY_ID = "identity";

/** What a paired device persists. The seed **is** the identity — treat it as such. */
export interface PersistedDeviceIdentity {
    username: string;
    /** Decimal-string Poseidon commitment. Pinned: a later pairing that yields a
     *  different commitment for this device must be refused, not adopted. */
    commitment: string;
    /** The 32-byte master seed. */
    seed: Uint8Array;
    pairedAt: number;
}

/** Thrown when persistence is impossible (no IndexedDB and/or no localStorage). */
export class DeviceStoreUnavailableError extends Error {
    constructor(what: string) {
        super(
            `Device identity can't be persisted here: ${what}. ` +
            "Pairing still works, but this device will have to pair again after a restart.",
        );
        this.name = "DeviceStoreUnavailableError";
    }
}

// ---- pluggable backends ----------------------------------------------------
//
// Both backends are injectable. This is a TEST SEAM (a `CryptoKey` round-trips
// through IndexedDB by structured clone, which no in-process IndexedDB shim
// reproduces faithfully) and doubles as the hook an embedder would use to point
// the store at its own storage. Apps should never need to call
// `configureDeviceStore`.

/** Key/value store for live `CryptoKey` objects (IndexedDB in the browser). */
export interface DeviceKeyVault {
    get(id: string): Promise<unknown | null>;
    put(id: string, value: unknown): Promise<void>;
    /** Delete the entire store — used by `clearDeviceIdentity`. */
    destroy(): Promise<void>;
}

/** String store for the sealed blob (localStorage in the browser). */
export interface DeviceBlobStore {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
}

/** The native Keystore bridge, when the shell provides one (see module docs). */
export interface MuhkooKeystoreBridge {
    wrap(b64plain: string): string | Promise<string>;
    unwrap(b64cipher: string): string | Promise<string>;
}

let injectedKeys: DeviceKeyVault | null | undefined;
let injectedBlobs: DeviceBlobStore | null | undefined;
let injectedKeystore: MuhkooKeystoreBridge | null | undefined;

/** Memoized so a pairing attempt and its follow-up touch use one keypair. */
let identityMemo: Promise<CryptoKeyPair> | null = null;
let identityEphemeral = false;

/**
 * Point the store at explicit backends (or `null` to force "unavailable"), and
 * reset the memoized device keypair. Testing / embedding seam — pass `{}` to
 * restore the default browser backends.
 */
export function configureDeviceStore(opts: {
    keys?: DeviceKeyVault | null;
    blobs?: DeviceBlobStore | null;
    keystore?: MuhkooKeystoreBridge | null;
} = {}): void {
    injectedKeys = opts.keys;
    injectedBlobs = opts.blobs;
    injectedKeystore = opts.keystore;
    identityMemo = null;
    identityEphemeral = false;
}

/**
 * True when {@link deviceIdentityKey} had to fall back to an in-memory keypair
 * because no key vault was available. Such a device can pair, but will never be
 * recognised as "known" afterwards (so approval always needs a fresh factor).
 */
export function deviceIdentityIsEphemeral(): boolean {
    return identityEphemeral;
}

// ---- public API ------------------------------------------------------------

/**
 * The device's **persistent** ECDSA P-256 identity keypair, created on first
 * call. This is not a browser fingerprint — it is a key, and every
 * `POST /api/auth/device/code` proves possession of it. Without that proof,
 * "known device" would be an unauthenticated string anyone could claim in order
 * to skip the approver's re-authentication.
 *
 * The private half is non-extractable and never leaves IndexedDB as bytes.
 */
export async function deviceIdentityKey(): Promise<CryptoKeyPair> {
    if (!identityMemo) identityMemo = loadOrCreateIdentityKey();
    try {
        return await identityMemo;
    } catch (e) {
        identityMemo = null; // don't cache a failure
        throw e;
    }
}

/** `base64url(SHA-256(raw SEC1 device identity public key))` — 43 chars. */
export async function deviceFingerprint(): Promise<string> {
    const pair = await deviceIdentityKey();
    return fingerprintOf(pair.publicKey);
}

/** Whether a sealed identity blob exists. Cheap: no crypto, no IndexedDB, no network. */
export async function hasDeviceIdentity(): Promise<boolean> {
    return blobStore()?.get(DEVICE_IDENTITY_STORAGE_KEY) != null;
}

/**
 * Seal and store the identity. Throws {@link DeviceStoreUnavailableError} when
 * there is nowhere to put it — callers should treat that as "this device won't
 * resume", not as a pairing failure.
 */
export async function persistDeviceIdentity(v: PersistedDeviceIdentity): Promise<void> {
    if (!(v?.seed instanceof Uint8Array) || v.seed.length !== 32) {
        throw new Error("persistDeviceIdentity: expected a 32-byte seed.");
    }
    const blobs = blobStore();
    if (!blobs) throw new DeviceStoreUnavailableError("no localStorage");

    const plain = TE.encode(JSON.stringify({
        username: v.username,
        commitment: v.commitment,
        seed: toBase64(v.seed),
        pairedAt: v.pairedAt,
    }));

    const bridge = keystoreBridge();
    let envelope: SealedIdentityBlob;
    if (bridge) {
        envelope = { v: 1, ks: 1, ct: await bridge.wrap(toBase64(plain)) };
    } else {
        const key = await wrapKey(true);
        if (!key) throw new DeviceStoreUnavailableError("no IndexedDB for the wrapping key");
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource),
        );
        envelope = { v: 1, iv: toBase64(iv), ct: toBase64(ct) };
    }
    blobs.set(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(envelope));
}

/**
 * Recover the persisted identity, or `null` when there is none / it can't be
 * opened (wiped IndexedDB, a different browser profile, a corrupted blob).
 * Never throws — a cold start with unreadable storage must fall back to a fresh
 * pairing, not to an error screen.
 */
export async function loadDeviceIdentity(): Promise<PersistedDeviceIdentity | null> {
    const blobs = blobStore();
    const raw = blobs?.get(DEVICE_IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    try {
        const envelope = JSON.parse(raw) as SealedIdentityBlob;
        if (envelope?.v !== 1) return null;

        let plain: Uint8Array;
        const bridge = keystoreBridge();
        if (envelope.ks === 1) {
            if (!bridge) return null; // sealed by the native shell; nothing else can open it
            plain = fromBase64(await bridge.unwrap(envelope.ct));
        } else {
            const key = await wrapKey(false);
            if (!key || !envelope.iv) return null;
            plain = new Uint8Array(await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromBase64(envelope.iv) as BufferSource },
                key,
                fromBase64(envelope.ct) as BufferSource,
            ));
        }

        const parsed = JSON.parse(TD.decode(plain)) as {
            username?: string; commitment?: string; seed?: string; pairedAt?: number;
        };
        if (!parsed?.username || !parsed?.commitment || !parsed?.seed) return null;
        const seed = fromBase64(parsed.seed);
        if (seed.length !== 32) return null;
        return {
            username: parsed.username,
            commitment: parsed.commitment,
            seed,
            pairedAt: typeof parsed.pairedAt === "number" ? parsed.pairedAt : 0,
        };
    } catch {
        return null;
    }
}

/**
 * Wipe everything: the sealed blob **and** the whole key database — so the
 * wrapping key never outlives the ciphertext it opens, and the device identity
 * key is regenerated (a re-pair is then correctly treated as a new device).
 */
export async function clearDeviceIdentity(): Promise<void> {
    identityMemo = null;
    identityEphemeral = false;
    try { blobStore()?.remove(DEVICE_IDENTITY_STORAGE_KEY); } catch { /* nothing to remove */ }
    try { await keyVault()?.destroy(); } catch { /* already gone */ }
}

// ---- internals -------------------------------------------------------------

interface SealedIdentityBlob {
    v: 1;
    /** Present (and `1`) when the native Keystore bridge produced `ct`. */
    ks?: 1;
    /** base64 12-byte AES-GCM IV. Absent for keystore-sealed blobs. */
    iv?: string;
    /** base64 ciphertext‖tag (WebCrypto) or the bridge's opaque wrap output. */
    ct: string;
}

async function fingerprintOf(publicKey: CryptoKey): Promise<string> {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw as BufferSource));
    return toBase64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function loadOrCreateIdentityKey(): Promise<CryptoKeyPair> {
    const vault = keyVault();
    if (vault) {
        const existing = (await vault.get(IDENTITY_KEY_ID)) as CryptoKeyPair | null;
        if (existing?.privateKey && existing?.publicKey) {
            identityEphemeral = false;
            return existing;
        }
    }
    // `extractable: false` applies to the PRIVATE half only — WebCrypto always
    // allows exporting a public key, which is what the fingerprint needs.
    const pair = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    if (vault) {
        try {
            await vault.put(IDENTITY_KEY_ID, pair);
            identityEphemeral = false;
            return pair;
        } catch { /* structured clone refused / quota — fall through */ }
    }
    // No durable home: keep it for this process only. Pairing still works; the
    // device just won't be recognised next boot.
    identityEphemeral = true;
    return pair;
}

/**
 * The AES-GCM wrapping key. `create` generates + stores one when absent;
 * otherwise a missing key means the blob is unopenable (return null, not throw).
 */
async function wrapKey(create: boolean): Promise<CryptoKey | null> {
    const vault = keyVault();
    if (!vault) return null;
    const existing = (await vault.get(WRAP_KEY_ID)) as CryptoKey | null;
    if (existing) return existing;
    if (!create) return null;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await vault.put(WRAP_KEY_ID, key);
    return key;
}

function keystoreBridge(): MuhkooKeystoreBridge | null {
    if (injectedKeystore !== undefined) return injectedKeystore;
    const ks = (globalThis as { MuhkooKeystore?: MuhkooKeystoreBridge }).MuhkooKeystore;
    return typeof ks?.wrap === "function" && typeof ks?.unwrap === "function" ? ks : null;
}

function blobStore(): DeviceBlobStore | null {
    if (injectedBlobs !== undefined) return injectedBlobs;
    try {
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        if (!ls) return null;
        ls.getItem("muhkoo.__probe__"); // Safari private mode throws on access, not on typeof
        return {
            get: (k) => ls.getItem(k),
            set: (k, v) => ls.setItem(k, v),
            remove: (k) => ls.removeItem(k),
        };
    } catch {
        return null;
    }
}

function keyVault(): DeviceKeyVault | null {
    if (injectedKeys !== undefined) return injectedKeys;
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return null;
    return indexedDbVault(idb);
}

/** Minimal promise wrapper over one object store. Opened per operation — these
 *  are cold-start-rare calls, and holding a connection open would block the
 *  `deleteDatabase` that `clearDeviceIdentity` needs to win. */
function indexedDbVault(idb: IDBFactory): DeviceKeyVault {
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        const req = idb.open(DEVICE_KEY_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DEVICE_KEY_STORE)) db.createObjectStore(DEVICE_KEY_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });

    return {
        async get(id) {
            const db = await open();
            try {
                return await new Promise((resolve, reject) => {
                    const req = db.transaction(DEVICE_KEY_STORE, "readonly").objectStore(DEVICE_KEY_STORE).get(id);
                    req.onsuccess = () => resolve(req.result ?? null);
                    req.onerror = () => reject(req.error);
                });
            } finally { db.close(); }
        },
        async put(id, value) {
            const db = await open();
            try {
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction(DEVICE_KEY_STORE, "readwrite");
                    tx.objectStore(DEVICE_KEY_STORE).put(value, id);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                    tx.onabort = () => reject(tx.error);
                });
            } finally { db.close(); }
        },
        destroy() {
            return new Promise<void>((resolve, reject) => {
                const req = idb.deleteDatabase(DEVICE_KEY_DB_NAME);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
                // A live connection elsewhere would block the delete; the blob is
                // already gone by then, so don't hang the sign-out on it.
                req.onblocked = () => resolve();
            });
        },
    };
}
