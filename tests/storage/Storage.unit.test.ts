import { describe, it, expect } from 'vitest';
import { Storage, StorageOptions } from '../../src/storage/Storage';
import { Network } from '../../src/network/Network';

/**
 * Mock Network class for testing
 */
class MockNetwork {
    async post(): Promise<any> {
        return {
            status: 200,
            statusText: 'OK',
            headers: {},
            data: { hash: 'mock-hash' }
        };
    }

    async get(): Promise<any> {
        return {
            status: 200,
            statusText: 'OK',
            headers: {},
            data: { chunks: [] }
        };
    }
}

describe('Storage - Unit Tests (No Encoding)', () => {
    describe('Constructor', () => {
        it('should create a Storage instance with network', () => {
            const mockNetwork = new MockNetwork();
            const storage = new Storage({
                network: mockNetwork as unknown as Network
            });

            expect(storage).toBeDefined();
            expect(storage).toBeInstanceOf(Storage);
            storage.destroy();
        });

        it('should throw an error if no network is provided', () => {
            expect(() => {
                new Storage({} as StorageOptions);
            }).toThrow('No network instance provided');
        });

        it('should accept custom configuration', () => {
            const mockNetwork = new MockNetwork();
            const storage = new Storage({
                network: mockNetwork as unknown as Network,
                dataShards: 8,
                parityShards: 4,
                chunkSize: 5 * 1024 * 1024
            });

            expect(storage).toBeDefined();
            storage.destroy();
        });
    });

    describe('destroy()', () => {
        it('should cleanup resources without errors', () => {
            const mockNetwork = new MockNetwork();
            const storage = new Storage({
                network: mockNetwork as unknown as Network
            });

            expect(() => storage.destroy()).not.toThrow();
        });

        it('should allow multiple destroy calls', () => {
            const mockNetwork = new MockNetwork();
            const storage = new Storage({
                network: mockNetwork as unknown as Network
            });

            storage.destroy();
            expect(() => storage.destroy()).not.toThrow();
        });
    });

    describe('Type validation', () => {
        it('should export StorageOptions type', () => {
            const mockNetwork = new MockNetwork();
            const options: StorageOptions = {
                network: mockNetwork as unknown as Network,
                dataShards: 4,
                parityShards: 2,
                chunkSize: 1024 * 1024
            };

            expect(options).toBeDefined();
            expect(options.network).toBeDefined();
            expect(options.dataShards).toBe(4);
            expect(options.parityShards).toBe(2);
            expect(options.chunkSize).toBe(1024 * 1024);
        });
    });
});
