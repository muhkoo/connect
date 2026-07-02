/**
 * `SpaceSignaler` — WebRTC signaling carried over the Space's existing ephemeral
 * relay. No new server channel: `Space.sendEphemeral`/`onEphemeral` already
 * blind-relay `pub` frames stamped with the authenticated sender, so SDP
 * offers/answers and ICE candidates ride a reserved subject (`__p2p__`) scoped
 * to Space membership. The sender (`from`) is server-stamped and can't be
 * spoofed; the payload is opaque to the server.
 *
 * Envelopes carry a `to` (a member id, or `"*"` for discovery) so the
 * accelerator can optionally unicast peer-pair signaling instead of broadcasting
 * (a small, backward-compatible `pub` enhancement); the client filters by `to`
 * regardless.
 */

export const P2P_SUBJECT = "__p2p__";

export type SignalKind = "hello" | "bye" | "offer" | "answer" | "ice";

export interface SignalEnvelope {
    /** Target member id, or `"*"` to broadcast (discovery / departure). */
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
        const env: SignalEnvelope = { to, kind, data };
        // Ask the server to unicast for a directed target; broadcast for "*".
        // `to` also stays in the envelope so a broadcast-only server still works
        // (the client filters by it).
        this.space.sendEphemeral(P2P_SUBJECT, env, to !== "*" ? to : undefined);
    }

    /** Announce/withdraw P2P availability to all Space members. */
    broadcast(kind: SignalKind, data?: unknown): void {
        this.send("*", kind, data);
    }

    /**
     * Subscribe to inbound signals addressed to us (or broadcast). Skips our own
     * echoes. Returns an unsubscribe function.
     */
    onSignal(cb: (from: string, kind: SignalKind, data: unknown) => void): () => void {
        return this.space.onEphemeral((e) => {
            if (e.subject !== P2P_SUBJECT || e.from === this.myId) return;
            const env = e.data as SignalEnvelope | undefined;
            if (!env || typeof env.kind !== "string") return;
            if (env.to !== this.myId && env.to !== "*") return;
            cb(e.from, env.kind, env.data);
        });
    }
}

export default SpaceSignaler;
