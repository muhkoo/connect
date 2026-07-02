/**
 * `WorkerEngineHost` — the main-thread proxy to a {@link ./blockEngine.BlockEngine}
 * running inside a dedicated Web Worker (so hashing, blockstore I/O, and the
 * protocol codec stay off the main thread). It speaks the small message protocol
 * in {@link ./blockEngine.worker} and satisfies {@link ./engineHost.EngineHost},
 * so {@link ../PeerNetwork} treats it identically to the in-process host.
 *
 * Block bytes cross the worker boundary as **transferable** ArrayBuffers
 * (zero-copy). Only encrypted blocks ever cross — keys never enter the worker.
 */

import type { EngineHost } from "./engineHost";

type WorkerOut =
    | { t: "out"; target: string; data: ArrayBuffer }
    | { t: "want-result"; id: number; data: ArrayBuffer | null };

export class WorkerEngineHost implements EngineHost {
    private readonly wants = new Map<number, (b: Uint8Array | null) => void>();
    private readonly cbs = new Set<(target: string, frame: Uint8Array) => void>();
    private nextId = 1;

    constructor(private readonly worker: Worker) {
        this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
            const m = e.data;
            if (m.t === "out") {
                const frame = new Uint8Array(m.data);
                for (const cb of this.cbs) cb(m.target, frame);
            } else if (m.t === "want-result") {
                const resolve = this.wants.get(m.id);
                if (resolve) {
                    this.wants.delete(m.id);
                    resolve(m.data ? new Uint8Array(m.data) : null);
                }
            }
        };
    }

    want(hash: string, timeoutMs: number): Promise<Uint8Array | null> {
        return new Promise((resolve) => {
            const id = this.nextId++;
            this.wants.set(id, resolve);
            this.worker.postMessage({ t: "want", id, hash, timeout: timeoutMs });
        });
    }

    announce(hash: string): void {
        this.worker.postMessage({ t: "announce", hash });
    }

    handleFrame(peer: string, frame: Uint8Array): void {
        // Transfer an exact-size buffer; copy if the view doesn't own the whole buffer.
        const buf =
            frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
                ? frame.buffer
                : frame.slice().buffer;
        this.worker.postMessage({ t: "frame", peer, data: buf }, [buf]);
    }

    onOutbound(cb: (target: string, frame: Uint8Array) => void): () => void {
        this.cbs.add(cb);
        return () => this.cbs.delete(cb);
    }

    close(): void {
        try { this.worker.postMessage({ t: "close" }); } catch { /* already gone */ }
        this.worker.terminate();
        this.wants.forEach((r) => r(null));
        this.wants.clear();
        this.cbs.clear();
    }
}

export default WorkerEngineHost;
