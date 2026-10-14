/**
 * The `[@muhkoo/connect] initialized — v…` build stamp is for a browser's
 * developer console only.
 *
 * In Node, `console.info` writes to STDOUT, so the line landed in front of
 * every CLI command's own output: `muhkoo kv ls --json | jq` failed with
 * "Unexpected token '@'", and `muhkoo kv ls | wc -l` counted the stamp as a key.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '../../src/core/Client';
import { MemorySessionStore } from '../../src/core/Session';

const BASE_URL = 'http://localhost:8787';

/** Every way the constructor could reach stdout: the console methods that write there, and the stream itself. */
function spyOnStdout() {
    return [
        vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'debug').mockImplementation(() => {}),
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    ];
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Client — build stamp', () => {
    it('constructing a Client in Node writes nothing to stdout', () => {
        expect(typeof window).toBe('undefined');
        const spies = spyOnStdout();
        new Client({ baseUrl: BASE_URL, offline: { enabled: false } });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it('still logs the stamp in a browser', () => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', {});
        const [info] = spyOnStdout();
        new Client({ baseUrl: BASE_URL, offline: { enabled: false }, sessionStore: new MemorySessionStore() });
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][0]).toMatch(/^\[@muhkoo\/connect\] initialized — v\d/);
    });
});
