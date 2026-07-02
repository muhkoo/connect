/**
 * `HLC` — a Hybrid Logical Clock. Hands out monotonically increasing
 * {@link HlcTimestamp} stamps that (a) track real time closely enough to be
 * human-meaningful, yet (b) never go backwards, even across a reload or when a
 * peer's clock is ahead of ours.
 *
 * Two operations, both the textbook HLC algorithm (Kulkarni et al.):
 *   - `now()` — stamp a local event.
 *   - `update(remote)` — observe a remote stamp (e.g. arriving on the realtime
 *     change feed) and advance our clock past it, so any event we generate
 *     afterwards is causally `> remote`.
 *
 * State is just `{ wall, counter }`; `nodeId` is fixed for the install. The
 * owner ({@link ../OfflineManager}) seeds the clock from persisted state on
 * boot and persists `getState()` after each tick so monotonicity survives page
 * reloads — without that, a reload could mint a stamp that loses to one written
 * seconds earlier.
 */

import { pack, type HlcParts } from "./HlcTimestamp";

export interface HlcState {
    wall: number;
    counter: number;
}

/** Injected physical-time source — defaults to `Date.now`. Overridable so
 *  tests can drive the clock deterministically. */
export type PhysicalClock = () => number;

export class HLC {
    private wall: number;
    private counter: number;
    private readonly nodeId: string;
    private readonly physical: PhysicalClock;

    constructor(nodeId: string, opts: { state?: HlcState | null; physical?: PhysicalClock } = {}) {
        this.nodeId = nodeId;
        this.physical = opts.physical ?? (() => Date.now());
        this.wall = opts.state?.wall ?? 0;
        this.counter = opts.state?.counter ?? 0;
    }

    /** Stamp a locally-generated event. Advances the clock. */
    now(): string {
        const pt = this.physical();
        const prevWall = this.wall;
        this.wall = Math.max(prevWall, pt);
        this.counter = this.wall === prevWall ? this.counter + 1 : 0;
        return this.current();
    }

    /**
     * Merge in an observed remote stamp and advance our clock strictly past it.
     * Call this for every inbound HLC (change-feed frames, history rows) so the
     * next `now()` is causally after anything we've seen.
     */
    update(remote: HlcParts): string {
        const pt = this.physical();
        const prevWall = this.wall;
        const newWall = Math.max(prevWall, remote.wall, pt);
        if (newWall === prevWall && newWall === remote.wall) {
            this.counter = Math.max(this.counter, remote.counter) + 1;
        } else if (newWall === prevWall) {
            this.counter = this.counter + 1;
        } else if (newWall === remote.wall) {
            this.counter = remote.counter + 1;
        } else {
            this.counter = 0;
        }
        this.wall = newWall;
        return this.current();
    }

    /** The current stamp without advancing the clock. */
    current(): string {
        return pack(this.wall, this.counter, this.nodeId);
    }

    /** Serializable `{ wall, counter }` for persistence. */
    getState(): HlcState {
        return { wall: this.wall, counter: this.counter };
    }
}

export default HLC;
