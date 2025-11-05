/**
 * Utilities Tests
 * Tests for utility functions including base58 encoding, checksums, ID generation, and serialization
 * Salvaged and consolidated from tests/v1/utilties/
 */

import { describe, it, expect } from 'vitest';
import {
  base58Encode,
  base58Decode,
  generateChecksum,
  verifyChecksum,
  _objectId,
  _socketId,
  _messageId,
  _userId,
  _accountId,
  _packetId,
  serialize,
  deserialize,
  generateId,
} from '../../src/utilities/index';

describe('Base58 Encoding', () => {
  describe('base58Encode', () => {
    it('should encode a Uint8Array to a Base58 string', () => {
      const input = new Uint8Array([58]);
      const output = base58Encode(input);

      expect(output).toBeDefined();
      expect(output).not.toBeNull();
      expect(typeof output).toBe('string');
    });

    it('should encode a Uint8Array with leading zeros to a Base58 string', () => {
      const input = new Uint8Array([0]);
      const output = base58Encode(input);

      expect(output).toBeDefined();
      expect(output).not.toBeNull();
      expect(output).toBe('1'); // Leading zeros become '1' in base58
    });

    it('should encode a string to Base58', () => {
      const input = 'Hello, World!';
      const output = base58Encode(input);

      expect(output).toBeDefined();
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    });

    it('should produce consistent output for same input', () => {
      const input = 'test data';
      const output1 = base58Encode(input);
      const output2 = base58Encode(input);

      expect(output1).toBe(output2);
    });

    it('should only use valid base58 characters', () => {
      const input = 'Hello, World!';
      const output = base58Encode(input);
      const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

      expect(base58Regex.test(output)).toBe(true);
    });
  });

  describe('base58Decode', () => {
    it('should decode a Base58 encoded string', () => {
      const input = '2g';
      const output = base58Decode(input);

      expect(output).toBeDefined();
      expect(output).not.toBeNull();
      expect(output).toBeInstanceOf(ArrayBuffer);
    });

    it('should decode a Base58 encoded string with leading zeros', () => {
      const input = '11';
      const output = base58Decode(input);

      expect(output).toBeDefined();
      expect(output).not.toBeNull();
      expect(output).toBeInstanceOf(ArrayBuffer);
    });

    it('should throw an error if the input is not a string', () => {
      expect(() => {
        base58Decode(123 as unknown as string);
      }).toThrow('Invalid input');
    });

    it('should throw an error if the input is not a valid Base58 string', () => {
      expect(() => {
        base58Decode('2g@'); // @ is not in base58 alphabet
      }).toThrow('Invalid input');
    });

    it('should handle empty leading ones correctly', () => {
      const encoded = '111ABC'; // Multiple leading zeros
      const decoded = base58Decode(encoded);
      const bytes = new Uint8Array(decoded);

      expect(bytes[0]).toBe(0);
      expect(bytes[1]).toBe(0);
      expect(bytes[2]).toBe(0);
    });
  });

  describe('base58 Round-Trip', () => {
    it('should encode and decode back to original string', () => {
      const original = 'Test message for base58 encoding';
      const encoded = base58Encode(original);
      const decoded = base58Decode(encoded);
      const result = new TextDecoder().decode(decoded);

      expect(result.trim()).toBe(original);
    });

    it('should encode and decode ArrayBuffer correctly', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 255, 128, 0]);
      const encoded = base58Encode(original.buffer);
      const decoded = new Uint8Array(base58Decode(encoded));

      expect(decoded).toEqual(original);
    });

    it('should handle unicode strings', () => {
      const original = 'Hello 世界 🌍';
      const encoded = base58Encode(original);
      const decoded = base58Decode(encoded);
      const result = new TextDecoder().decode(decoded);

      expect(result.trim()).toBe(original);
    });
  });
});

describe('Checksum Functions', () => {
  describe('generateChecksum', () => {
    it('should generate a checksum for a given input', () => {
      const input = 'Hello, World!';
      const checksum = generateChecksum(input);

      expect(checksum).toBeDefined();
      expect(checksum).not.toBeNull();
      expect(checksum).not.toBe('');
      expect(typeof checksum).toBe('string');
    });

    it('should generate consistent checksums for same input', () => {
      const input = 'Test data';
      const checksum1 = generateChecksum(input);
      const checksum2 = generateChecksum(input);

      expect(checksum1).toBe(checksum2);
    });

    it('should generate different checksums for different inputs', () => {
      const input1 = 'Hello';
      const input2 = 'World';
      const checksum1 = generateChecksum(input1);
      const checksum2 = generateChecksum(input2);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should be sensitive to case changes', () => {
      const checksum1 = generateChecksum('Hello');
      const checksum2 = generateChecksum('hello');

      expect(checksum1).not.toBe(checksum2);
    });

    it('should handle empty strings', () => {
      const checksum = generateChecksum('');

      expect(checksum).toBeDefined();
      expect(typeof checksum).toBe('string');
    });
  });

  describe('verifyChecksum', () => {
    it('should return true for a valid checksum', () => {
      const input = 'Hello, World!';
      const checksum = generateChecksum(input);

      expect(verifyChecksum(input, checksum)).toBe(true);
    });

    it('should return false for an invalid checksum', () => {
      const input = 'Hello, World!';
      const checksum = generateChecksum(input);

      expect(verifyChecksum(input, checksum + '123')).toBe(false);
    });

    it('should return false when input is modified', () => {
      const input = 'Original message';
      const checksum = generateChecksum(input);

      expect(verifyChecksum('Modified message', checksum)).toBe(false);
    });

    it('should handle empty string checksums', () => {
      const checksum = generateChecksum('');

      expect(verifyChecksum('', checksum)).toBe(true);
      expect(verifyChecksum('not empty', checksum)).toBe(false);
    });
  });
});

describe('ID Generation', () => {
  describe('generateId', () => {
    it('should generate a valid base58-encoded ID', () => {
      const id = generateId();

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }

      expect(ids.size).toBe(100);
    });
  });

  describe('_objectId', () => {
    it('should generate a valid object ID', () => {
      const id = _objectId();

      expect(id).toBeDefined();
      expect(id).not.toBeNull();
      expect(id).not.toBe('');
      expect(id).toContain('OBJ');
    });

    it('should generate a unique object ID', () => {
      const id1 = _objectId();
      const id2 = _objectId();

      expect(id1).not.toBe(id2);
    });

    it('should have content after prefix', () => {
      const id = _objectId();
      const justId = id.replace('OBJ', '');

      expect(justId).not.toBe('');
      expect(justId.length).toBeGreaterThan(0);
    });
  });

  describe('_socketId', () => {
    it('should generate a valid socket ID', () => {
      const id = _socketId();

      expect(id).toBeDefined();
      expect(id).not.toBeNull();
      expect(id).not.toBe('');
      expect(id).toContain('SKT');
    });

    it('should generate a unique socket ID', () => {
      const id1 = _socketId();
      const id2 = _socketId();

      expect(id1).not.toBe(id2);
    });

    it('should have content after prefix', () => {
      const id = _socketId();
      const justId = id.replace('SKT', '');

      expect(justId).not.toBe('');
    });
  });

  describe('_messageId', () => {
    it('should generate a valid message ID', () => {
      const id = _messageId();

      expect(id).toBeDefined();
      expect(id).not.toBeNull();
      expect(id).not.toBe('');
      expect(id).toContain('MSG');
    });

    it('should generate a unique message ID', () => {
      const id1 = _messageId();
      const id2 = _messageId();

      expect(id1).not.toBe(id2);
    });

    it('should have content after prefix', () => {
      const id = _messageId();
      const justId = id.replace('MSG', '');

      expect(justId).not.toBe('');
    });
  });

  describe('_userId', () => {
    it('should generate a valid user ID', () => {
      const id = _userId();

      expect(id).toBeDefined();
      expect(id).toContain('USR');
    });

    it('should generate unique user IDs', () => {
      const id1 = _userId();
      const id2 = _userId();

      expect(id1).not.toBe(id2);
    });
  });

  describe('_accountId', () => {
    it('should generate a valid account ID', () => {
      const id = _accountId();

      expect(id).toBeDefined();
      expect(id).toContain('ACC');
    });

    it('should generate unique account IDs', () => {
      const id1 = _accountId();
      const id2 = _accountId();

      expect(id1).not.toBe(id2);
    });
  });

  describe('_packetId', () => {
    it('should generate a valid packet ID', () => {
      const id = _packetId();

      expect(id).toBeDefined();
      expect(id).toContain('PKT');
    });

    it('should generate unique packet IDs', () => {
      const id1 = _packetId();
      const id2 = _packetId();

      expect(id1).not.toBe(id2);
    });
  });
});

describe('Serialization', () => {
  describe('serialize and deserialize', () => {
    it('should serialize and deserialize a simple object', () => {
      const data = {
        key: 'value',
        number: 42,
        boolean: true,
      };

      const serialized = serialize(data);
      expect(serialized).toBeDefined();
      expect(typeof serialized).toBe('string');

      const deserialized = deserialize(serialized);
      expect(deserialized).toEqual(data);
    });

    it('should serialize and deserialize a complex object', () => {
      const data = {
        key: 'value',
        array: [1, 2, 3],
        nested: { a: true, b: 'test' },
        date: new Date(),
        map: new Map([['key', 'value']]),
        set: new Set([1, 2, 3]),
      };

      const serialized = serialize(data);
      const deserialized = deserialize(serialized);

      expect(deserialized).toBeDefined();
      expect(deserialized).not.toBeNull();
      expect(deserialized).toEqual(data);
    });

    it('should handle arrays correctly', () => {
      const data = {
        numbers: [1, 2, 3, 4, 5],
        strings: ['a', 'b', 'c'],
        mixed: [1, 'two', true, null],
      };

      const serialized = serialize(data);
      const deserialized = deserialize(serialized);

      expect(deserialized).toEqual(data);
    });

    it('should handle nested objects', () => {
      const data = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
            },
          },
        },
      };

      const serialized = serialize(data);
      const deserialized = deserialize(serialized);

      expect(deserialized).toEqual(data);
    });

    it('should handle Date objects', () => {
      const now = new Date();
      const data = {
        timestamp: now,
        name: 'test',
      };

      const serialized = serialize(data);
      const deserialized = deserialize<typeof data>(serialized);

      expect(deserialized.timestamp).toBeInstanceOf(Date);
      expect(deserialized.timestamp.getTime()).toBe(now.getTime());
    });

    it('should handle Map objects', () => {
      const data = {
        map: new Map([
          ['key1', 'value1'],
          ['key2', 'value2'],
        ]),
      };

      const serialized = serialize(data);
      const deserialized = deserialize<typeof data>(serialized);

      expect(deserialized.map).toBeInstanceOf(Map);
      expect(deserialized.map.get('key1')).toBe('value1');
      expect(deserialized.map.get('key2')).toBe('value2');
    });

    it('should handle Set objects', () => {
      const data = {
        set: new Set([1, 2, 3, 4, 5]),
      };

      const serialized = serialize(data);
      const deserialized = deserialize<typeof data>(serialized);

      expect(deserialized.set).toBeInstanceOf(Set);
      expect(deserialized.set.has(1)).toBe(true);
      expect(deserialized.set.has(5)).toBe(true);
      expect(deserialized.set.size).toBe(5);
    });

    it('should handle null and undefined', () => {
      const data = {
        nullValue: null,
        undefinedValue: undefined,
        regularValue: 'test',
      };

      const serialized = serialize(data);
      const deserialized = deserialize(serialized);

      expect(deserialized.nullValue).toBeNull();
      expect(deserialized.regularValue).toBe('test');
    });

    it('should produce base58-encoded strings', () => {
      const data = { test: 'value' };
      const serialized = serialize(data);
      const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

      expect(base58Regex.test(serialized)).toBe(true);
    });

    it('should handle empty objects', () => {
      const data = {};
      const serialized = serialize(data);
      const deserialized = deserialize(serialized);

      expect(deserialized).toEqual(data);
    });

    it('should handle empty arrays', () => {
      const data = { items: [] };
      const serialized = serialize(data);
      const deserialized = deserialize(serialized);

      expect(deserialized).toEqual(data);
    });
  });
});
