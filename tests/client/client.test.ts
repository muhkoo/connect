/**
 * ApiClient Tests
 * Tests for type-safe API client with E2E encryption
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '../../src/core/Client';

// Mock fetch globally
global.fetch = vi.fn();

describe('Client - Initialization', () => {
    let client: Client;

    beforeEach(() => {
        client = new Client({
            apiKey: 'test-api-key',
            network: {
                url: 'http://localhost:8787',
                clientId: 'test-client-id',
                serverId: 'test-server-id',
            },
        });
    });
    it('should initialize with basic config', () => {
        console.log('Client initialized with config:', client);
        expect(client).toBeDefined();
    });

    it('should initialize with basic config', () => {
        console.log('Client initialized with config:', client);
        expect(client).toBeDefined();
    });
});