import { certBytes } from "./canonical";
import { verifyP256 } from "./ik";
import type { ChatKeyCert } from "./types";

/** The signer surface a cert needs (satisfied by IdentitySigner); kept local so spaces/ never imports core/. */
export interface CertSigner {
    sign(bytes: Uint8Array): Promise<string>;
    identityKeyRaw(): Promise<string>;
}

/**
 * A certificate by the account IK over the member's P-384 chat keys (design §3.2).
 * `ecdh`/`ecdsa` must be the EXACT strings posted as identityEcdhPub/identityEcdsaPub.
 * Minted in memory, never stored client-side.
 */
export async function mintKeyCert(signer: CertSigner, memberId: string, ecdh: string, ecdsa: string): Promise<ChatKeyCert> {
    const ik = await signer.identityKeyRaw();
    const sig = await signer.sign(certBytes(memberId, { ik, ecdh, ecdsa }));
    return { v: 1, ik, ecdh, ecdsa, sig };
}

export async function verifyKeyCert(memberId: string, cert: ChatKeyCert, ecdh: string, ecdsa: string): Promise<boolean> {
    if (!cert || cert.v !== 1 || cert.ecdh !== ecdh || cert.ecdsa !== ecdsa) return false;
    return verifyP256(cert.ik, cert.sig, certBytes(memberId, cert));
}
