import { describe, it, expect } from 'vitest';
import RS, { WorkerMessage } from '../../../../src/storage/encoding/ReedSolomon';


function generateRandomContent(sizeInBytes: number): string {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < sizeInBytes; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}


const filePath = "./rstest.txt";

function createFile() {
    const fs = require('fs');
    const sizeInMB = 50; // Specify size in MB
    const sizeInBytes = sizeInMB * 1024 * 1024; // Convert to bytes
    const some_string = generateRandomContent(sizeInBytes);
    fs.writeFileSync(filePath, some_string);
}

function delFile() {
    const fs = require('fs');
    fs.unlinkSync(filePath);
}


describe('ReedSolomon', () => {
    it('should encode and decode data', async () => {
        let _readyResolver: (value?: unknown) => void;
        const _readyPromise = new Promise(resolve => {
            _readyResolver = resolve;
        })
        createFile();
        const data = require('fs').
            readFileSync(filePath);
        const rs = new RS();
        console.time('Encoding');
        rs.encoder.on('encoded', (event: CustomEvent<WorkerMessage['data']>) => {

            const encoded = event.detail;
            expect(encoded).not.toBeNull();

            expect(encoded.shards).toBeDefined();
            expect(encoded.shards!.length).toBeGreaterThan(0);
            expect(encoded.shardsCount).toBeGreaterThan(0);
            expect(encoded.parityShards).toBeGreaterThan(0);
            rs.decode(encoded.shards!, encoded.parityShards, encoded.deadSharedIndexes);
        })

        rs.encoder.on('decoded', (event: CustomEvent<WorkerMessage['data']>) => {
            const decoded = event.detail;
            expect(decoded).not.toBeNull();
            expect(decoded.buffer).toBeDefined();
            expect(decoded.buffer!.length).toBeGreaterThan(0);
            delFile();
            _readyResolver();
        })
        rs.encode(data, 6, 4);
        await _readyPromise;
        console.timeEnd('Encoding');
    });

});