import { AbstractStorage } from '../../../src/storage/AbstractStorage';
import { describe, it, expect } from 'vitest';

describe('AbstractStorage', () => {
    it('should create a new AbstractStorage instance', () => {
        const storage = new AbstractStorage();
        expect(storage).toBeDefined();
        expect(storage).not.toBeNull();
        expect(storage).toBeInstanceOf(AbstractStorage);
    });

    it('should throw an error when delete is called', async () => {
        const storage = new AbstractStorage();
        await expect(storage.delete("test")).rejects.toThrow("Method not implemented.");
    })
});