import { assertType } from "../../../utilities";

export type WorkerMessageType = 'encode' | 'decode' | 'encoded' | 'decoded';

export type WorkerMessageData = {
    buffer?: Buffer;
    shards?: Uint8Array[];
    shardsCount: number;
    parityShards: number;
    deadSharedIndexes: number[];
};

export class WorkerMessage {
    type: WorkerMessageType;
    data: WorkerMessageData;
    constructor(type: WorkerMessageType, data: WorkerMessageData) {
        assertType(type, 'string');
        assertType(data, 'object');
        assertType(data.shardsCount, 'number');
        assertType(data.parityShards, 'number');
        if (!(data.deadSharedIndexes instanceof Array)) {
            throw new Error('WorkerMessage: data.deadSharedIndexes must be an array');
        }
        if (typeof data.buffer === 'undefined' && typeof data.shards === 'undefined') {
            throw new Error('WorkerMessage: data.buffer or data.shards must be defined');
        }
        this.type = type;
        this.data = data;
    }
}