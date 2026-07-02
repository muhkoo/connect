/**
 * Dedicated Web Worker entry that hosts a {@link ./blockEngine.BlockEngine}. The
 * blockstore is the Cache-API-backed {@link ../../offline/cache/ShardCache}
 * (the Cache API is available in workers and origin-scoped, so it's the *same*
 * store the main thread reads), and hashing uses {@link
 * ../../storage/transport/ShardClient.shardHash}.
 *
 * Message protocol (see {@link ./engineClient.WorkerEngineHost}):
 *   in : {t:"frame",peer,data} | {t:"want",id,hash,timeout} | {t:"announce",hash} | {t:"close"}
 *   out: {t:"out",target,data}  | {t:"want-result",id,data}
 *
 * Consumers instantiate this with a bundler-resolved URL, e.g.
 *   new Worker(new URL("@muhkoo/connect/dist/.../blockEngine.worker.js", import.meta.url), { type: "module" })
 * and pass `() => that worker` as `workerFactory` to the client's p2p options.
 */

import { BlockEngine } from "./blockEngine";
import { ShardCache } from "../../offline/cache/ShardCache";
import { shardHash } from "../../storage/transport/ShardClient";

/** Minimal worker-scope shape (avoids needing the WebWorker tsconfig lib). */
interface WorkerScope {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

const engine = new BlockEngine(
    new ShardCache(),
    (target, frame) => {
        const buf = frame.buffer as ArrayBuffer;
        ctx.postMessage({ t: "out", target, data: buf }, [buf]);
    },
    shardHash,
);

ctx.onmessage = (e: MessageEvent) => {
    const m = e.data as
        | { t: "frame"; peer: string; data: ArrayBuffer }
        | { t: "want"; id: number; hash: string; timeout: number }
        | { t: "announce"; hash: string }
        | { t: "close" };

    if (m.t === "frame") {
        void engine.handleFrame(m.peer, new Uint8Array(m.data));
    } else if (m.t === "want") {
        void engine.want(m.hash, m.timeout).then((bytes) => {
            const buf = bytes ? (bytes.buffer as ArrayBuffer) : null;
            ctx.postMessage({ t: "want-result", id: m.id, data: buf }, buf ? [buf] : []);
        });
    } else if (m.t === "announce") {
        engine.announce(m.hash);
    } else if (m.t === "close") {
        engine.close();
    }
};
