/**
 * `SpaceSignaler` — WebRTC signaling carried over the Space's existing ephemeral
 * relay. No new server channel: `Space.sendEphemeral`/`onEphemeral` already
 * blind-relay `pub` frames stamped with the authenticated sender, so SDP
 * offers/answers and ICE candidates ride a reserved subject (`__p2p__`) scoped
 * to Space membership. The sender (`from`) is server-stamped and can't be
 * spoofed; the payload is opaque to the server.
 *
 * Peers are identified by a unique **peer id** (per device/connection), carried
 * in the envelope's `from`/`to` — NOT by the server-stamped member id. This is
 * essential: one user's own devices share a member id, so the server's `from`
 * can't tell them apart (and would make each treat the others' signals as its
 * own echo). We therefore route entirely on the envelope peer ids and broadcast
 * to the whole Space, filtering client-side. The server `from` still guarantees
 * the sender is an authenticated Space member.
 */

export const P2P_SUBJECT = "__p2p__";

export type SignalKind = "hello" | "bye" | "offer" | "answer" | "ice";

export interface SignalEnvelope {
    /** Sender's unique PEER id (per device/connection). */
    from: string;
    /** Target peer id, or `"*"` to broadcast (discovery / departure). */
    to: string;
    kind: SignalKind;
    data?: unknown;
}

/** The slice of {@link ../../spaces/Space.Space} the signaler needs. */
export interface SignalingSpace {
    sendEphemeral(subject: string, data: unknown, to?: string): void;
    onEphemeral(handler: (e: { from: string; subject: string; data: unknown }) => void): () => void;
}

export class SpaceSignaler {
    constructor(
        private readonly space: SignalingSpace,
        private readonly myId: string,
    ) {}

    /** Send a signal to one peer (or `"*"`). */
    send(to: string, kind: SignalKind, data?: unknown): void {
        const env: SignalEnvelope = { from: this.myId, to, kind, data };
        // Always broadcast to the Space: the server can't unicast to a specific
        // DEVICE (a user's devices share a member id), so we route client-side on
        // the envelope peer id. Signaling frames are tiny.
        this.space.sendEphemeral(P2P_SUBJECT, env);
    }

    /** Announce/withdraw P2P availability to all Space members. */
    broadcast(kind: SignalKind, data?: unknown): void {
        this.send("*", kind, data);
    }

    /**
     * Subscribe to inbound signals addressed to us (or broadcast). Skips our own
     * echoes. Returns an unsubscribe function. Routing is entirely by the envelope
     * peer id (`env.from`/`env.to`), so a user's own devices — which share the
     * server-stamped `e.from` — are correctly distinguished.
     */
    onSignal(cb: (from: string, kind: SignalKind, data: unknown) => void): () => void {
        return this.space.onEphemeral((e) => {
            if (e.subject !== P2P_SUBJECT) return;
            const env = e.data as SignalEnvelope | undefined;
            if (!env || typeof env.kind !== "string" || typeof env.from !== "string") return;
            if (env.from === this.myId) return; // our own device's echo
            if (env.to !== this.myId && env.to !== "*") return;
            cb(env.from, env.kind, env.data);
        });
    }
}

export default SpaceSignaler;
