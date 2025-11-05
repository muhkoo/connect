import { EventCore } from "../../events/EventCore";

export class AbstractEncoder extends EventCore {
    constructor() {
        super();
    }
    encode(data: Buffer, shardsCount: number, parityShards: number): void {
        throw new Error("Method not implemented.");
    }

    decode(shards: Uint8Array[], parityShards: number, deadSharedIndexes: number[]): void {
        throw new Error("Method not implemented.");
    }

    destroy(): void {
        throw new Error("Method not implemented.");
    }
}

export default AbstractEncoder;