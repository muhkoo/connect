import { MuhkooObject } from '../../../src/storage/objects/MuhkooObject';
import { describe, it, expect } from 'vitest';
describe('MuhkooObject', () => {
    it('should create a new MuhkooObject instance', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        expect(obj).toBeDefined();
        expect(obj).not.toBeNull();
        expect(obj).toBeInstanceOf(MuhkooObject);
    });

    it('should add a key to the object', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        obj.addPart("key1");
        obj.addPart("key2");
        expect(obj.getParts()).toEqual(["key1", "key2"]);
    });

    it('should return the object name', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        expect(obj.getName()).toBe("test");
    });

    it('should return the object size', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        expect(obj.getSize()).toBe(100);
    });

    it('should return the object type', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text/plain" });
        expect(obj.getType()).toBe("text/plain");
    });

    it('should return the object icon', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        obj.setIcon("icon.png");
        expect(obj.getIcon()).toBe("icon.png");
    });

    it('should return the object keys', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        obj.addPart("key1");
        obj.addPart("key2");
        expect(obj.getParts()).toEqual(["key1", "key2"]);
    })

    it('should serialize the object', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        obj.addPart("key1");
        obj.addPart("key2");
        const serialized = obj.serialize();
        expect(serialized).toBeDefined();
        expect(serialized).not.toBeNull();
        expect(typeof serialized).toBe("string");
    })

    it('should deserialize the object', () => {
        const obj = new MuhkooObject({ name: "test", size: 100, type: "text" });
        obj.addPart("key1");
        obj.addPart("key2");
        console.log(obj.getParts());
        const serialized = obj.serialize();
        console.log(serialized);
        const deserialized = MuhkooObject.deserialize(serialized);
        console.log(deserialized);
        expect(deserialized).toBeDefined();
        expect(deserialized).not.toBeNull();
        expect(deserialized).toBeInstanceOf(MuhkooObject);
        expect(deserialized.getName()).toBe("test");
        expect(deserialized.getSize()).toBe(100);
        expect(deserialized.getType()).toBe("text");
        expect(deserialized.getParts()).toEqual(["key1", "key2"]);
    })
})