import { Worker } from 'worker_threads';
import { WorkerMessage } from './WorkerMessage';
import { AbstractEncoder } from '../AbstractEncoder';
import * as path from 'path';
import { EventCoreEvents } from '../../../events';


export class NodeWorker extends AbstractEncoder {

    private worker: Worker;

    constructor() {
        super();
        this.worker = new Worker(path.resolve(__dirname, './RsEncodeDecodeWorker.cjs'), { name: 'RsEncodeDecodeWorker' });
        this.worker.on('message', (data) => {
            const message = data.data as WorkerMessage;
            this.emit(message.type, message.data);
        });
        this.worker.on('error', (err) => {
            appLogger.error(err);
        })
    }

    encode(data: Buffer, shardsCount: number, parityShards: number) {
        const message = new WorkerMessage('encode', {
            buffer: data,
            shardsCount,
            parityShards,
            deadSharedIndexes: [],
        });
        this.worker.postMessage(message);
    }

    decode(shards: Uint8Array[], parityShards: number, deadSharedIndexes: number[]) {
        const message = new WorkerMessage('decode', {
            shards,
            shardsCount: shards.length,
            parityShards,
            deadSharedIndexes,
        });
        this.worker.postMessage(message);
    }

    destroy() {
        this.worker.terminate();
    }

    emit (type: string, data?: any): void {
        return NodeWorker.emit(type as EventCoreEvents, data);
    }

    on (type: string, listener: (event: CustomEvent<any>) => void): void {
        return NodeWorker.on(type as EventCoreEvents, listener);
    }

    off (type: string, listener: (event: CustomEvent<any>) => void): void {
        return NodeWorker.off(type as EventCoreEvents, listener);
    }

}

export default NodeWorker;