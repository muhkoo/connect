/**
 * Node entry.
 *
 * Byte-identical to the browser entry: investigation found no genuine
 * server/browser split. `src/auth/passkey.ts` and `src/auth/deviceStore.ts`
 * touch `navigator` / `localStorage` / `indexedDB` only inside functions behind
 * `typeof` guards, and nothing in `src/utilities` or `src/core` imports a Node
 * builtin (`getIPAddress` is fetch-based). The two builds differ in bundling,
 * not in surface.
 */

import "../runtime/appLogger";

export * from "../api";
