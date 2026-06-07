/**
 * Shared types for the Space fan-out group-encryption layer.
 *
 * A Space is a group channel whose messages are sealed once with a symmetric
 * group key (`K_space`) rather than per-peer like the Double Ratchet. That
 * single ciphertext is decryptable by every member that holds the epoch key,
 * which is what lets the server persist + replay messages as history while
 * staying blind to their contents.
 */

/**
 * How a space treats history across membership changes.
 *  - `static`: one group key for all time (epoch 0). New members can read the
 *    entire history; a removed member keeps the key until you rotate manually.
 *  - `rotate`: a new epoch key is minted on membership change. Members only
 *    hold keys for the epochs they belonged to, so they cannot read messages
 *    from epochs before they joined / after they left.
 */
export type HistoryPolicy = "static" | "rotate";

/**
 * An ECIES-wrapped copy of a group key, sealed to one member's identity ECDH
 * public key. Opaque to the server — useless without the member's private key.
 */
export interface WrappedKey {
    /** Epoch this key belongs to (0 for static spaces). */
    epoch: number;
    /** Base64url-encoded JWK of the ephemeral ECDH public key used for the wrap. */
    ephemeralPub: string;
    /** Base64 AES-GCM IV (12 bytes). */
    iv: string;
    /** Base64 AES-GCM ciphertext: the wrapped 32-byte group key + tag. */
    ciphertext: string;
    /** Algorithm tag for forward-compat. */
    alg: string;
}

/** Cleartext space metadata the server records once at creation. */
export interface SpaceMetadata {
    /** Encoded space public key (the space's logical identity). */
    spaceId: string;
    historyPolicy: HistoryPolicy;
    /** Advisory monotonic epoch counter. */
    currentEpoch: number;
}

/**
 * A newcomer's request for the group key. The newcomer self-asserts its
 * identity public keys (trust-on-first-use at the client layer; the server is
 * blind and cannot validate them).
 */
export interface JoinRequest {
    memberId: string;
    /** Base64url-encoded JWK of the member's identity ECDH public key. */
    identityEcdhPub: string;
    /** Base64url-encoded JWK of the member's identity ECDSA public key (optional). */
    identityEcdsaPub?: string;
    /** Epoch the newcomer wants a key for (defaults to current). */
    desiredEpoch?: number;
    ts?: number;
}

/**
 * The cleartext header fields a sealed space message carries inside its
 * `Packet.headers`. The server reads/persists/routes on these; the actual
 * `Message` payload lives encrypted inside `ciphertext`.
 */
export interface SealedPacketHeaders {
    /** Discriminator marking this packet as group-sealed (vs Double Ratchet). */
    spaceSealed: true;
    /** Epoch whose group key seals `ciphertext`. */
    epoch: number;
    /** Base64 AES-GCM IV. */
    iv: string;
    /** Base64 AES-GCM ciphertext of the serialized `Message`. */
    ciphertext: string;
    /** App MIME hint, surfaced to receivers. */
    contentType?: string;
    /** Base64 ECDSA signature by the sender's identity key over the canonical
     * `{source,target,subject,epoch,iv,ciphertext}` — proves authorship. */
    sig?: string;
    [k: string]: string | number | boolean | undefined;
}

/** A space member's published identity keys (the keyring directory). */
export interface RosterMember {
    memberId: string;
    /** Base64url-encoded JWK of the member's identity ECDH public key. */
    identityEcdhPub: string;
    /** Base64url-encoded JWK of the member's identity ECDSA public key. */
    identityEcdsaPub?: string;
}

/** A shareable invite link to a space. Redeeming it allowlists the holder so
 *  the keeper admits them. */
export interface InviteLink {
    /** The capability token; embed in a URL to share. */
    token: string;
    /** Member id (username) that created the link. */
    createdBy?: string;
    createdAt?: number;
    /** Epoch ms when the link stops working; 0 = never. */
    expiresAt?: number;
    /** Max redemptions; 0 = unlimited. */
    maxUses?: number;
    /** Redemptions so far. */
    uses?: number;
    /** Access level granted to redeemers ("viewer" | "editor"). */
    role?: string;
}
