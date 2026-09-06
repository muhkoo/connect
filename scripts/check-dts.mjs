#!/usr/bin/env node
/**
 * Refuse to publish without a current type bundle.
 *
 * `dist/connect.d.ts` is in the `files` allowlist, so it ships — but for a long
 * time nothing BUILT it: `build` emitted JS only, and a publish carried whatever
 * happened to be left in dist, or nothing. 0.14.0-alpha.3 went to npm with no
 * declarations at all, which does not fail loudly: consumers keep compiling, but
 * every SDK type silently becomes `any`, and the first symptom is an unrelated
 * type error somewhere downstream.
 *
 * `build` now runs `build:dts`. This is the backstop for publishing a stale dist.
 */
import { statSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dts = join(root, "dist", "connect.d.ts");

if (!existsSync(dts)) {
    console.error("check-dts: dist/connect.d.ts is MISSING. Run `yarn build` before publishing.");
    process.exit(1);
}

/** Newest mtime under src/, so a d.ts older than the source is caught too. */
function newest(dir) {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        latest = Math.max(latest, entry.isDirectory() ? newest(p) : statSync(p).mtimeMs);
    }
    return latest;
}

const built = statSync(dts).mtimeMs;
const source = newest(join(root, "src"));
if (built < source) {
    console.error(
        "check-dts: dist/connect.d.ts is OLDER than src/ — it would ship stale types.\n" +
        "  Run `yarn build` and publish again.",
    );
    process.exit(1);
}
console.log(`check-dts: OK — dist/connect.d.ts is present and newer than src/ (${Math.round(statSync(dts).size / 1024)} KB).`);
