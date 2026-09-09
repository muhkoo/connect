/**
 * Browser entry.
 *
 * The surface is defined once in `src/api.ts`; this file names no symbols so it
 * cannot drift from the server entry or from `dist/connect.d.ts`.
 */

import "../runtime/appLogger";

export * from "../api";
