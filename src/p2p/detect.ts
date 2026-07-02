/**
 * Whether this environment can do WebRTC peering. `RTCPeerConnection` is
 * Window-only (absent in Node/Workers/SSR), so this gates whether a
 * {@link ./PeerNetwork} can be built at all.
 */
export function isP2pCapable(): boolean {
    try {
        return typeof RTCPeerConnection !== "undefined";
    } catch {
        return false;
    }
}
