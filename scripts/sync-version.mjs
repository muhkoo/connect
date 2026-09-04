#!/usr/bin/env node
/**
 * Stamp `src/version.ts` from `package.json`.
 *
 * That constant is what a `Client` prints to the console on construction, and its
 * only job is to answer "is this page running the build I just shipped, or a
 * cached one?". A stale value does not merely go unnoticed — it answers that
 * question WRONGLY, during exactly the debugging session where someone is
 * relying on it. It was previously kept in step by a comment asking nicely, and
 * 0.14.0-alpha.0 duly shipped announcing itself as 0.13.2-alpha.0.
 *
 * Run as part of `build`, so the stamp cannot lag the artifact:
 *
 *   node scripts/sync-version.mjs          # rewrite src/version.ts
 *   node scripts/sync-version.mjs --check  # fail if it is stale (publish gate)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CHECK = process.argv.includes("--check");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = join(root, "src", "version.ts");

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const source = await readFile(versionPath, "utf8");

const RE = /^export const VERSION = "(.*)";$/m;
const found = source.match(RE);
if (!found) {
    console.error("sync-version: could not find `export const VERSION = \"…\";` in src/version.ts");
    process.exit(1);
}

if (found[1] === version) {
    console.log(`sync-version: OK — src/version.ts is ${version}.`);
    process.exit(0);
}

if (CHECK) {
    console.error(
        `sync-version: src/version.ts is stale.\n` +
        `  package.json:    ${version}\n` +
        `  src/version.ts:  ${found[1]}  ✗\n` +
        "Run `yarn sync-version` (or just `yarn build`) and re-publish.",
    );
    process.exit(1);
}

await writeFile(versionPath, source.replace(RE, `export const VERSION = "${version}";`));
console.log(`sync-version: stamped src/version.ts ${found[1]} → ${version}.`);
