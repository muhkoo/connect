import { WorkerMessage } from './WorkerMessage';
import { NodeWorker } from './NodeWorker';


class ReedSolomon {
    private _encoder: NodeWorker;
    // need options for the encoder
    constructor() {
        this._encoder = new NodeWorker();
    }

    get encoder() {
        return this._encoder;
    }

    encode(data: Buffer, shardsCount: number, parityShards: number) {
        this._encoder.encode(data, shardsCount, parityShards);
    }

    decode(shards: Uint8Array[], parityShards: number, deadSharedIndexes: number[]) {
        this._encoder.decode(shards, parityShards, deadSharedIndexes);
    }

    destroy() {
        this._encoder.destroy();
    }
}

export {
    ReedSolomon,
    NodeWorker,
    WorkerMessage
};

export default ReedSolomon;