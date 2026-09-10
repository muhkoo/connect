/**
 * The SDK's process-global logger.
 *
 * Eight modules under `src/` read a bare `appLogger` off `globalThis` rather
 * than importing one (`src/crypto/{KeyStore,DoubleRatchet,DoubleRatchetManager,
 * Authenticator}.ts`, `src/core/Client.ts`,
 * `src/core/namespaces/HostedAuth.ts`, `src/events/EventCore.ts`), so the
 * binding has to exist before any of them runs, and the `declare global` below
 * is what makes that typecheck.
 *
 * This module is the single place that bootstrap happens. It previously lived
 * inline in three entry files — `src/browser/index.ts`, `src/workers/index.ts`,
 * and `src/core/index.ts` (which `src/server/index.ts` picked up as an import
 * side effect) — three copies that could drift.
 *
 * `??=` makes it idempotent, so importing it from several entries in one
 * process is safe and the first writer wins.
 *
 * KNOWN HAZARD: package.json declares `"sideEffects": false`, which entitles a
 * tree-shaker to drop a module imported purely for effect. The entries import
 * this one for its `export`s as well, so it survives today — but the durable
 * fix is to convert those eight bare reads into real imports of `appLogger`
 * from here, which removes the reliance on a global entirely.
 */

import { Logger } from "../utilities/Logger";

declare global {
    // eslint-disable-next-line no-var
    var appLogger: InstanceType<typeof Logger>;
}

export const appLogger: InstanceType<typeof Logger> = (globalThis.appLogger ??= new Logger(
    "connect",
    "ERROR",
));

export { Logger };
export default appLogger;
