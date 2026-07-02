/**
 * `WebRtcTransport` — a {@link ./PeerTransport.PeerTransport} over RTCDataChannels,
 * signaled by {@link ../signaling/SpaceSignaler}. Runs on the **main thread**
 * (`RTCPeerConnection` is Window-only — not available in Workers), so the block
 * engine lives in a Worker and this only shuttles bytes.
 *
 * Connection setup uses a deterministic initiator (the peer with the smaller id
 * dials) to avoid offer/answer glare. STUN handles NAT traversal; there is no
 * TURN — an unreachable peer simply never connects and the caller falls back to
 * origin (P2P is best-effort).
 *
 * Frames (up to a 4 MiB shard) exceed an RTCDataChannel's max message size, so
 * each frame is fragmented into `CHUNK`-sized pieces with a 12-byte header
 * `[msgId u32][index u32][total u32]` and reassembled per peer.
 */

import type { PeerId, PeerTransport } from "./PeerTransport";
import type { SpaceSignaler, SignalKind } from "../signaling/SpaceSignaler";

const CHUNK = 16 * 1024;
// [msgId u32][index u32][total u32][channel u32]
const HEADER = 16;
/** Pause sends when a channel has this many bytes buffered (backpressure). */
const MAX_BUFFERED = 4 * 1024 * 1024;

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

interface Reassembly {
    chunks: Array<Uint8Array | undefined>;
    received: number;
    total: number;
    size: number;
    channel: number;
}

interface PeerConn {
    pc: RTCPeerConnection;
    dc?: RTCDataChannel;
    reasm: Map<number, Reassembly>;
}

export interface WebRtcTransportOptions {
    iceServers?: RTCIceServer[];
    /** Cap on simultaneous peer connections (mesh size). Default 8. */
    maxPeers?: number;
}

export class WebRtcTransport implements PeerTransport {
    private readonly conns = new Map<PeerId, PeerConn>();
    private readonly msgCbs = new Set<(peer: PeerId, data: Uint8Array, channel: number) => void>();
    private readonly peerCbs = new Set<(peers: PeerId[]) => void>();
    private readonly offSignal: () => void;
    private readonly iceServers: RTCIceServer[];
    private readonly maxPeers: number;
    private nextMsgId = 1;

    constructor(
        private readonly signaler: SpaceSignaler,
        private readonly myId: PeerId,
        opts: WebRtcTransportOptions = {},
    ) {
        this.iceServers = opts.iceServers ?? DEFAULT_ICE;
        this.maxPeers = opts.maxPeers ?? 8;
        this.offSignal = this.signaler.onSignal((from, kind, data) => this.onSignal(from, kind, data));
    }

    peers(): PeerId[] {
        return [...this.conns].filter(([, c]) => c.dc?.readyState === "open").map(([id]) => id);
    }

    /** Dial a peer (no-op unless we're the deterministic initiator for the pair). */
    connectTo(peerId: PeerId): void {
        if (peerId === this.myId || this.conns.has(peerId)) return;
        if (this.conns.size >= this.maxPeers) return; // mesh cap
        if (this.myId < peerId) void this.initiate(peerId); // smaller id dials
    }

    send(peer: PeerId, data: Uint8Array, channel = 0): void {
        const dc = this.conns.get(peer)?.dc;
        if (dc?.readyState === "open") void this.sendFragmented(dc, data, channel);
    }

    broadcast(data: Uint8Array, channel = 0): void {
        for (const [, c] of this.conns) {
            if (c.dc?.readyState === "open") void this.sendFragmented(c.dc, data, channel);
        }
    }

    onMessage(cb: (peer: PeerId, data: Uint8Array, channel: number) => void): () => void {
        this.msgCbs.add(cb);
        return () => this.msgCbs.delete(cb);
    }

    onPeerChange(cb: (peers: PeerId[]) => void): () => void {
        this.peerCbs.add(cb);
        return () => this.peerCbs.delete(cb);
    }

    close(): void {
        this.offSignal();
        for (const [, c] of this.conns) {
            try { c.dc?.close(); } catch { /* already closing */ }
            try { c.pc.close(); } catch { /* already closing */ }
        }
        this.conns.clear();
        this.msgCbs.clear();
        this.peerCbs.clear();
    }

    // -- internals -----------------------------------------------------------

    private newPc(peerId: PeerId): PeerConn {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        const conn: PeerConn = { pc, reasm: new Map() };
        this.conns.set(peerId, conn);
        pc.onicecandidate = (e) => {
            if (e.candidate) this.signaler.send(peerId, "ice", e.candidate.toJSON());
        };
        pc.onconnectionstatechange = () => {
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.drop(peerId);
        };
        pc.ondatachannel = (e) => this.bindChannel(peerId, conn, e.channel);
        return conn;
    }

    private async initiate(peerId: PeerId): Promise<void> {
        const conn = this.newPc(peerId);
        const dc = conn.pc.createDataChannel("blocks");
        this.bindChannel(peerId, conn, dc);
        const offer = await conn.pc.createOffer();
        await conn.pc.setLocalDescription(offer);
        this.signaler.send(peerId, "offer", offer);
    }

    private bindChannel(peerId: PeerId, conn: PeerConn, dc: RTCDataChannel): void {
        dc.binaryType = "arraybuffer";
        conn.dc = dc;
        dc.onopen = () => this.firePeerChange();
        dc.onclose = () => this.drop(peerId);
        dc.onmessage = (e) => this.onChunk(peerId, conn, new Uint8Array(e.data as ArrayBuffer));
    }

    private async onSignal(from: PeerId, kind: SignalKind, data: unknown): Promise<void> {
        if (kind === "offer") {
            if (!this.conns.has(from) && this.conns.size >= this.maxPeers) return; // mesh cap
            const conn = this.conns.get(from) ?? this.newPc(from);
            await conn.pc.setRemoteDescription(data as RTCSessionDescriptionInit);
            const answer = await conn.pc.createAnswer();
            await conn.pc.setLocalDescription(answer);
            this.signaler.send(from, "answer", answer);
        } else if (kind === "answer") {
            const conn = this.conns.get(from);
            if (conn) await conn.pc.setRemoteDescription(data as RTCSessionDescriptionInit);
        } else if (kind === "ice") {
            const conn = this.conns.get(from);
            if (conn && data) {
                try { await conn.pc.addIceCandidate(data as RTCIceCandidateInit); } catch { /* pre-SRD race */ }
            }
        } else if (kind === "bye") {
            this.drop(from);
        }
    }

    private drop(peerId: PeerId): void {
        const conn = this.conns.get(peerId);
        if (!conn) return;
        this.conns.delete(peerId);
        try { conn.dc?.close(); } catch { /* already closing */ }
        try { conn.pc.close(); } catch { /* already closing */ }
        this.firePeerChange();
    }

    private firePeerChange(): void {
        const peers = this.peers();
        for (const cb of this.peerCbs) cb(peers);
    }

    // -- fragmentation -------------------------------------------------------

    private async sendFragmented(dc: RTCDataChannel, data: Uint8Array, channel: number): Promise<void> {
        const msgId = this.nextMsgId++ >>> 0;
        const total = Math.max(1, Math.ceil(data.length / CHUNK));
        for (let i = 0; i < total; i++) {
            const slice = data.subarray(i * CHUNK, (i + 1) * CHUNK);
            const frame = new Uint8Array(HEADER + slice.length);
            const dv = new DataView(frame.buffer);
            dv.setUint32(0, msgId);
            dv.setUint32(4, i);
            dv.setUint32(8, total);
            dv.setUint32(12, channel);
            frame.set(slice, HEADER);
            if (dc.bufferedAmount > MAX_BUFFERED) await this.drain(dc);
            dc.send(frame);
        }
    }

    private drain(dc: RTCDataChannel): Promise<void> {
        return new Promise((resolve) => {
            dc.bufferedAmountLowThreshold = MAX_BUFFERED / 2;
            const onLow = () => { dc.removeEventListener("bufferedamountlow", onLow); resolve(); };
            dc.addEventListener("bufferedamountlow", onLow);
        });
    }

    private onChunk(peerId: PeerId, conn: PeerConn, frame: Uint8Array): void {
        if (frame.length < HEADER) return;
        const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const msgId = dv.getUint32(0);
        const index = dv.getUint32(4);
        const total = dv.getUint32(8);
        const channel = dv.getUint32(12);
        const chunk = frame.slice(HEADER);

        let r = conn.reasm.get(msgId);
        if (!r) {
            r = { chunks: new Array(total), received: 0, total, size: 0, channel };
            conn.reasm.set(msgId, r);
        }
        if (r.chunks[index]) return; // dup
        r.chunks[index] = chunk;
        r.received++;
        r.size += chunk.length;
        if (r.received < r.total) return;

        conn.reasm.delete(msgId);
        const out = new Uint8Array(r.size);
        let off = 0;
        for (const c of r.chunks) {
            if (!c) return; // gap — shouldn't happen on reliable ordered
            out.set(c, off);
            off += c.length;
        }
        for (const cb of this.msgCbs) cb(peerId, out, r.channel);
    }
}

export default WebRtcTransport;
