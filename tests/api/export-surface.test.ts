/**
 * Export-surface parity harness.
 *
 * The public surface of this package is hand-maintained in three entry files
 * (`src/browser/index.ts`, `src/server/index.ts`, `src/workers/index.ts`) plus
 * the `src/core/index.ts` barrel, and they have drifted apart. `package.json`
 * maps `main` -> `dist/server/index.js`, `browser` -> `dist/browser/index.js`
 * and `workerd` -> `dist/workers/index.js`, but points `types` at a single
 * `dist/connect.d.ts` for all three — and that d.ts is rolled from the BROWSER
 * entry. So today Node consumers get types for symbols that are `undefined` at
 * runtime, and workerd consumers are told 175 symbols exist that do not.
 *
 * This file is the safety net for the export-consolidation work: it pins
 * today's surface, encodes today's drift as explicit allowlists, and turns any
 * future change into a reviewable diff. It is deliberately GREEN against the
 * un-consolidated tree — the allowlists below are the bug list, not the goal.
 *
 * ── Two extractors, neither of which executes the code ──────────────────────
 *
 * SOURCE side uses the TypeScript checker (`getExportsOfModule`), not a runtime
 * import. That is not a stylistic preference: importing `src/browser/index.ts`
 * under vitest fails outright with
 *
 *     Error: "ESM integration proposal for Wasm" is not supported currently.
 *       ❯ src/workers/groth16-verifier.ts:19  import loadBundledBn128 from "./wasm/bn128.wasm"
 *
 * The checker also sees TYPE exports, which is the entire point — `DbQuery` and
 * friends are type-only and a runtime `Object.keys()` would never see them.
 *
 * ARTIFACT side parses the built bundles with `ts.createSourceFile` and walks
 * top-level `ExportDeclaration` nodes. Do NOT be tempted to replace this with a
 * regex. An unanchored /export (?:type )?\{([^}]*)\}/g over `dist/connect.d.ts`
 * reports 425 names instead of the true 418, inventing `FrameType`, `decode`,
 * `encodeBlock`, `encodeCancel`, `encodeHave`, `encodeWant` and `DecodedFrame`
 * out of the INDENTED export statement inside `declare namespace protocol {`
 * (near connect.d.ts:7487). Only an AST walk of *top-level* statements is
 * correct here.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const abs = (rel: string) => path.join(ROOT, rel);

const BROWSER_ENTRY = 'src/browser/index.ts';
const SERVER_ENTRY = 'src/server/index.ts';
const WORKERS_ENTRY = 'src/workers/index.ts';

const DTS = 'dist/connect.d.ts';
const BROWSER_JS = 'dist/browser/index.js';
const SERVER_JS = 'dist/server/index.js';
const WORKERS_JS = 'dist/workers/index.js';
const WORKERS_DTS = 'dist/connect.workers.d.ts';

const SNAPSHOT = 'api-surface.txt';
const WORKERS_SNAPSHOT = 'api-surface.workers.txt';

/** A module's exported names, split by whether they exist at runtime. */
interface Surface {
    values: Set<string>;
    types: Set<string>;
}

const sorted = (s: Iterable<string>) => [...s].sort();
/** Names in `a` that are absent from `b`. */
const only = (a: Set<string>, b: Set<string>) => sorted([...a].filter((n) => !b.has(n)));
const bullets = (names: string[]) => names.map((n) => `  - ${n}`).join('\n');

// ───────────────────────────── extractor (A): source ─────────────────────────
//
// One program for the whole file — creating it walks all of `src/`, so it is
// built once and memoized rather than per-test.

let programCache: ts.Program | undefined;

function getProgram(): ts.Program {
    if (programCache) return programCache;
    const configPath = abs('tsconfig.json');
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) {
        throw new Error(`could not read tsconfig.json: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
    }
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT);
    const entries = [BROWSER_ENTRY, SERVER_ENTRY, WORKERS_ENTRY].map(abs);
    programCache = ts.createProgram({
        rootNames: [...new Set([...parsed.fileNames, ...entries])],
        options: parsed.options,
    });
    return programCache;
}

/**
 * The exported surface of a source entry, via the checker.
 *
 * A symbol counts as a VALUE if it (or, for a re-export alias, its aliased
 * target) carries `SymbolFlags.Value`; everything else is a TYPE. Resolving the
 * alias matters because every one of these entries is built out of
 * `export * from '…'`, so almost nothing is declared locally.
 */
function sourceSurface(rel: string): Surface {
    const program = getProgram();
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(abs(rel));
    if (!sourceFile) throw new Error(`entry not in program: ${rel}`);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`entry is not a module (no exports?): ${rel}`);

    const values = new Set<string>();
    const types = new Set<string>();
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const flags =
            exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported).flags : exported.flags;
        (flags & ts.SymbolFlags.Value ? values : types).add(exported.getName());
    }
    return { values, types };
}

// ──────────────────────────── extractor (B): artifact ────────────────────────

/**
 * The exported surface of a BUILT file, by parsing it. Never executes it.
 *
 * Only TOP-LEVEL `export { … }` / `export type { … }` statements count — see
 * the `declare namespace protocol` trap in the file header. A name is a TYPE if
 * either the statement (`export type { A, B }`) or the element
 * (`export { type A, B }`) is type-only.
 */
function artifactSurface(rel: string): Surface {
    const file = abs(rel);
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const values = new Set<string>();
    const types = new Set<string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)) continue;
        const clause = statement.exportClause;
        if (!clause || !ts.isNamedExports(clause)) continue;
        for (const element of clause.elements) {
            (statement.isTypeOnly || element.isTypeOnly ? types : values).add(element.name.text);
        }
    }
    return { values, types };
}

const hasBuild =
    existsSync(abs(DTS)) &&
    existsSync(abs(BROWSER_JS)) &&
    existsSync(abs(WORKERS_JS)) &&
    existsSync(abs(WORKERS_DTS));

// The artifact assertions below are the only ones that check what actually
// SHIPS. dist/ is gitignored, so without this guard a clean CI checkout would
// silently skip them and a rollup/dts-config regression that never touches
// src/ would go green. CI sets REQUIRE_BUILD_ARTIFACTS=1 after `yarn build`.
if (process.env.REQUIRE_BUILD_ARTIFACTS === '1' && !hasBuild) {
    throw new Error(
        'REQUIRE_BUILD_ARTIFACTS=1 but dist/ is missing or incomplete. ' +
            `Run \`yarn build\` first. Looked for: ${DTS}, ${BROWSER_JS}, ${WORKERS_JS}.`,
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. REQUIRED-SYMBOL FLOOR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The CLAUDE.md headline surface — the API this SDK documents and promises.
 *
 * Removing a name from this list is a DELIBERATE PUBLIC-API DECISION, not a
 * test fix. If a change makes one of these fail, the change dropped a
 * documented export; fix the export, do not edit this list to match.
 *
 * This assertion exists because a pure set-equality / delta check between the
 * entries would have PASSED on the pre-fix tree: the `Db*` symbols were missing
 * from the browser entry AND from `connect.d.ts` *consistently*, so the delta
 * was zero. A delta-only gate is structurally blind to the exact bug that
 * motivated this work. Only an absolute floor catches it.
 */
const REQUIRED_VALUES = [
    'Client',
    'VERSION',
    'AuthNamespace',
    'KvNamespace',
    'DbNamespace',
    'DbTable',
    'StorageNamespace',
    'MessageNamespace',
    'SpaceNamespace',
    'VfsNamespace',
    'VcsNamespace',
    'AgentsNamespace',
    'FunctionsNamespace',
    'AccessTokensNamespace',
    'HostedAuth',
    'HttpClient',
    'SessionState',
    'Space',
];

/** Type-only members of the same headline surface. Same rule applies. */
const REQUIRED_TYPES = [
    'ClientOptions',
    'DbQuery',
    'DbQueryResult',
    'DbFilterOp',
    'DbWhereCondition',
    'VfsStat',
    'AuthUser',
];

/**
 * Headline symbols that are MISSING from the browser surface today.
 *
 * This is a quarantine, not an exemption: the floor assertion below demands the
 * missing set match this list EXACTLY, so a 25th name silently falling off the
 * surface still fails, and fixing one of these also fails — telling you to
 * delete the line. It must only ever shrink.
 *
 * `VERSION` (`src/version.ts`) is re-exported from `src/server/index.ts` but not
 * from `src/browser/index.ts`, so it is absent from `connect.d.ts` too. A
 * browser consumer cannot `import { VERSION } from '@muhkoo/connect'` even
 * though the Client stamps that exact constant to the console on construction.
 * This is a live instance of the very bug this harness guards, and it is
 * consistent across the entry and the d.ts — which is precisely why the
 * delta-only checks in this file cannot see it. The consolidation work fixes it.
 */
// EMPTY. VERSION used to be server-only — and missing from connect.d.ts too,
// so the delta was zero and no delta-based check could see it. src/api.ts now
// exports it. A name reappearing here is a public-API regression, not a test fix.
const KNOWN_MISSING_FROM_BROWSER: string[] = [];

describe('required-symbol floor', () => {
    it(`keeps every headline symbol on the surface of ${BROWSER_ENTRY}`, () => {
        const surface = sourceSurface(BROWSER_ENTRY);
        const missingValues = REQUIRED_VALUES.filter((n) => !surface.values.has(n));
        const missingTypes = REQUIRED_TYPES.filter((n) => !surface.types.has(n));
        const missing = sorted([...missingValues, ...missingTypes]);

        const regressions = missing.filter((n) => !KNOWN_MISSING_FROM_BROWSER.includes(n));
        const fixed = KNOWN_MISSING_FROM_BROWSER.filter((n) => !missing.includes(n));

        expect(
            missing,
            [
                regressions.length
                    ? `REGRESSION — these documented exports vanished from ${BROWSER_ENTRY}:\n${bullets(regressions)}\n` +
                      'They are part of the CLAUDE.md headline surface. Restore the export; ' +
                      'do not delete them from REQUIRED_VALUES/REQUIRED_TYPES to make this pass.'
                    : '',
                fixed.length
                    ? `FIXED — these are now exported from ${BROWSER_ENTRY}:\n${bullets(fixed)}\n` +
                      'Delete them from KNOWN_MISSING_FROM_BROWSER. That list may only shrink.'
                    : '',
            ]
                .filter(Boolean)
                .join('\n\n'),
        ).toEqual(sorted(KNOWN_MISSING_FROM_BROWSER));
    });

    it.skipIf(!hasBuild)(`keeps every headline symbol in ${DTS}`, () => {
        const surface = artifactSurface(DTS);
        const missingValues = REQUIRED_VALUES.filter((n) => !surface.values.has(n));
        const missingTypes = REQUIRED_TYPES.filter((n) => !surface.types.has(n));
        const missing = sorted([...missingValues, ...missingTypes]);

        const regressions = missing.filter((n) => !KNOWN_MISSING_FROM_BROWSER.includes(n));
        const fixed = KNOWN_MISSING_FROM_BROWSER.filter((n) => !missing.includes(n));

        expect(
            missing,
            [
                regressions.length
                    ? `REGRESSION — these documented exports are absent from ${DTS}:\n${bullets(regressions)}\n` +
                      `The d.ts is rolled from ${BROWSER_ENTRY}, so check that entry first, then rerun ` +
                      '`yarn build:dts`. This is a shipped-typings bug, not a test problem.'
                    : '',
                fixed.length
                    ? `FIXED — these now appear in ${DTS}:\n${bullets(fixed)}\n` +
                      'Delete them from KNOWN_MISSING_FROM_BROWSER. That list may only shrink.'
                    : '',
            ]
                .filter(Boolean)
                .join('\n\n'),
        ).toEqual(sorted(KNOWN_MISSING_FROM_BROWSER));
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. ENTRY PARITY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every name here is a bug. The export-consolidation work deletes lines from
 * this list; it must only ever shrink.
 *
 * These are the symbols that exist on exactly one of the browser/server
 * surfaces. Because `package.json` ships ONE `dist/connect.d.ts` (rolled from
 * the browser entry) as the typings for both conditions, each `serverOnly*`
 * name is a runtime export with no types, and each `browserOnly*` name is a
 * type that Node consumers will find `undefined` at runtime.
 *
 * Measured against commit 028792c. The assertion below requires an EXACT match,
 * so closing a gap fails the test until you delete the corresponding line —
 * that is the ratchet.
 */
const KNOWN_DRIFT = {
    // EMPTY, and it must stay that way. The browser and server entries are now
    // byte-identical re-exports of src/api.ts, so any drift between them means
    // someone reintroduced a hand-maintained platform delta. If you are about to
    // add a name here, add it to src/api.ts (or src/api.universal.ts) instead.
    serverOnlyValues: [] as string[],
    browserOnlyValues: [] as string[],
    serverOnlyTypes: [] as string[],
    browserOnlyTypes: [] as string[],
};

/**
 * Compares a measured one-sided difference against its allowlist and returns an
 * actionable message, or `undefined` when they match.
 */
function driftReport(label: string, measured: string[], allowed: string[]): string | undefined {
    const added = measured.filter((n) => !allowed.includes(n));
    const removed = allowed.filter((n) => !measured.includes(n));
    if (!added.length && !removed.length) return undefined;
    return [
        `${label}:`,
        added.length ? `  NEW DRIFT (a regression — export it from both entries):\n${bullets(added)}` : '',
        removed.length ? `  RESOLVED (delete these from KNOWN_DRIFT.${label}):\n${bullets(removed)}` : '',
    ]
        .filter(Boolean)
        .join('\n');
}

describe('entry parity — browser vs server', () => {
    it('differs only by the symbols in KNOWN_DRIFT', () => {
        const browser = sourceSurface(BROWSER_ENTRY);
        const server = sourceSurface(SERVER_ENTRY);

        const measured = {
            serverOnlyValues: only(server.values, browser.values),
            browserOnlyValues: only(browser.values, server.values),
            serverOnlyTypes: only(server.types, browser.types),
            browserOnlyTypes: only(browser.types, server.types),
        };

        const reports = (Object.keys(measured) as Array<keyof typeof measured>)
            .map((k) => driftReport(k, measured[k], KNOWN_DRIFT[k]))
            .filter(Boolean);

        expect(
            measured,
            reports.length
                ? `Export drift between ${BROWSER_ENTRY} and ${SERVER_ENTRY} changed.\n\n` +
                  `${reports.join('\n\n')}\n\n` +
                  'Every name in KNOWN_DRIFT is a bug: the package ships one ' +
                  `${DTS} (rolled from the browser entry) as the typings for both conditions, ` +
                  'so a server-only value has no types and a browser-only name is undefined ' +
                  'at runtime under Node. The list may only shrink.'
                : '',
        ).toEqual({
            serverOnlyValues: sorted(KNOWN_DRIFT.serverOnlyValues),
            browserOnlyValues: sorted(KNOWN_DRIFT.browserOnlyValues),
            serverOnlyTypes: sorted(KNOWN_DRIFT.serverOnlyTypes),
            browserOnlyTypes: sorted(KNOWN_DRIFT.browserOnlyTypes),
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. WORKERS CONTAINMENT
// ═════════════════════════════════════════════════════════════════════════════

describe('workers containment', () => {
    it(`exports a strict subset of ${BROWSER_ENTRY}`, () => {
        const workers = sourceSurface(WORKERS_ENTRY);
        const browser = sourceSurface(BROWSER_ENTRY);

        const strayValues = only(workers.values, browser.values);
        const strayTypes = only(workers.types, browser.types);

        // eslint-disable-next-line no-console
        console.info(
            `[export-surface] workers ${workers.values.size} values / ${workers.types.size} types ` +
                `⊆ browser ${browser.values.size} values / ${browser.types.size} types`,
        );

        expect(
            { strayValues, strayTypes },
            `${WORKERS_ENTRY} exports names that ${BROWSER_ENTRY} does not:\n` +
                `${bullets([...strayValues, ...strayTypes])}\n` +
                'The workers entry is meant to be a Workers-safe SUBSET of the browser ' +
                'surface. A workers-only export cannot be typed, because ' +
                `${DTS} is rolled from the browser entry.`,
        ).toEqual({ strayValues: [], strayTypes: [] });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3b. WORKERS FLOOR — the lower bound
// ═════════════════════════════════════════════════════════════════════════════
//
// Containment above is an UPPER bound only, and ∅ satisfies it. Without a floor,
// emptying src/workers/index.ts to `export {}` — or dropping the groth16-verifier
// re-export, the single thing the workers build exists for — passes silently.
// That was a real hole: both breakages were demonstrated green before this block
// was added.
//
// WORKERS_REQUIRED is the contract the accelerator actually consumes. Verified
// against accelerator/src/durable-objects/userAuth/zk.ts:10 and
// accelerator/src/services/zk-verifier.ts:20-27 — the only two production
// workerd import sites in the monorepo.
const WORKERS_REQUIRED_VALUES = ['verifyGroth16', 'initBn128Wasm', 'PREIMAGE_POK_VERIFICATION_KEY'];
const WORKERS_REQUIRED_TYPES = ['Bn128WasmInstance', 'VerificationKey', 'Groth16Proof'];

describe('workers floor', () => {
    it('keeps the symbols the accelerator imports', () => {
        const workers = sourceSurface(WORKERS_ENTRY);
        const missing = [
            ...WORKERS_REQUIRED_VALUES.filter((n) => !workers.values.has(n)),
            ...WORKERS_REQUIRED_TYPES.filter((n) => !workers.types.has(n)),
        ];
        expect(
            sorted(missing),
            'The workerd surface lost symbols the accelerator imports:\n' +
                `${bullets(sorted(missing))}\n` +
                'These are the Groth16 verification primitives that are the entire ' +
                'reason the workers build exists. Do not delete them from this list ' +
                'to make the test pass.',
        ).toEqual([]);
    });

    it(`matches ${WORKERS_SNAPSHOT}`, () => {
        const rendered = renderSnapshot(sourceSurface(WORKERS_ENTRY));
        const file = abs(WORKERS_SNAPSHOT);

        if (process.env.UPDATE_API_SURFACE === '1') {
            writeFileSync(file, rendered, 'utf8');
            return;
        }
        expect(
            existsSync(file),
            `${WORKERS_SNAPSHOT} is missing. It is a committed artifact — regenerate ` +
                'with UPDATE_API_SURFACE=1 and commit it.',
        ).toBe(true);

        const actual = snapshotBody(rendered);
        const committed = snapshotBody(readFileSync(file, 'utf8'));
        expect(
            actual,
            `The workerd public surface changed.\n` +
                (actual.filter((l) => !committed.includes(l)).length
                    ? `  ADDED:\n${bullets(actual.filter((l) => !committed.includes(l)))}\n`
                    : '') +
                (committed.filter((l) => !actual.includes(l)).length
                    ? `  REMOVED (breaking for workerd consumers):\n${bullets(committed.filter((l) => !actual.includes(l)))}\n`
                    : '') +
                `\nRegenerate with UPDATE_API_SURFACE=1 once the change is intended.`,
        ).toEqual(committed);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3c. NO AMBIGUOUS STAR EXPORTS
// ═════════════════════════════════════════════════════════════════════════════
//
// The checker-based source extractor OVER-REPORTS on ambiguous star exports:
// for `export * from './a'; export * from './b'` where both export `Client`,
// ES runtime semantics DROP `Client` entirely, while getExportsOfModule still
// reports it. That is precisely this repo's historical failure mode, and the
// entries are built from ~40 `export *` lines, so the extractor could certify a
// surface that does not exist at runtime. tsc reports these as TS2308; assert
// directly on the diagnostics so the harness cannot mislead a reviewer.
const AMBIGUITY_CODES = new Set([2308, 2323, 2484]);

describe('no ambiguous star exports', () => {
    it('has no TS2308/TS2323/TS2484 anywhere in the program', () => {
        const program = getProgram();
        const offenders = program
            .getSemanticDiagnostics()
            .filter((d) => AMBIGUITY_CODES.has(d.code))
            .map((d) => {
                const where = d.file
                    ? `${path.relative(ROOT, d.file.fileName)}:${
                          d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1
                      }`
                    : '(no file)';
                return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
            });

        expect(
            offenders,
            'Ambiguous star exports detected. When two `export *` lines export the ' +
                'same name from different declarations, ES semantics silently DROP that ' +
                'name at runtime, while this file\'s checker-based extractor still ' +
                'reports it as present. Resolve with an explicit named re-export.\n' +
                bullets(offenders),
        ).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. NO-SNARKJS CLOSURE INVARIANT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * snarkjs and friends depend on `URL.createObjectURL` and `worker_threads`,
 * neither of which Cloudflare Workers exposes. A single import of any of these
 * anywhere in the workers entry's reachable graph breaks the production CF
 * build — and does so with no signal until it is deployed. Hence this test.
 */
const WORKERS_FORBIDDEN = /^(snarkjs|@zk-kit\/groth16|circomlibjs|ffjavascript)$/;

interface Closure {
    files: Set<string>;
    external: Set<string>;
    nonLiteralDynamicImports: string[];
}

/** Every module specifier reachable from `sourceFile`, static and dynamic. */
function moduleSpecifiers(sourceFile: ts.SourceFile): Array<string | null> {
    const found: Array<string | null> = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            found.push(node.moduleSpecifier.text);
        }
        if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteral(node.moduleReference.expression)
        ) {
            found.push(node.moduleReference.expression.text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            // `null` = a dynamic import we cannot statically resolve. Reported,
            // because it is a hole in this invariant rather than a pass.
            found.push(arg && ts.isStringLiteral(arg) ? arg.text : null);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

/** Transitively walks the static AND dynamic import graph from an entry file. */
function importClosure(entry: string): Closure {
    const configPath = abs('tsconfig.json');
    const parsed = ts.parseJsonConfigFileContent(
        ts.readConfigFile(configPath, ts.sys.readFile).config,
        ts.sys,
        ROOT,
    );
    const host = ts.createCompilerHost(parsed.options);

    const files = new Set<string>();
    const external = new Set<string>();
    const nonLiteralDynamicImports: string[] = [];
    const stack = [abs(entry)];

    while (stack.length) {
        const file = stack.pop() as string;
        if (files.has(file)) continue;
        files.add(file);

        let text: string;
        try {
            text = readFileSync(file, 'utf8');
        } catch {
            continue; // e.g. a `.wasm` that resolved to a real path we can't parse
        }
        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

        for (const specifier of moduleSpecifiers(sourceFile)) {
            if (specifier === null) {
                nonLiteralDynamicImports.push(path.relative(ROOT, file));
                continue;
            }
            const resolved = ts.resolveModuleName(specifier, file, parsed.options, host).resolvedModule
                ?.resolvedFileName;
            if (resolved && !resolved.includes('node_modules') && /\.(ts|tsx|js|mjs)$/.test(resolved)) {
                stack.push(resolved);
            } else {
                external.add(specifier);
            }
        }
    }
    return { files, external, nonLiteralDynamicImports };
}

describe('workers build — no-snarkjs closure invariant', () => {
    it('reaches no Workers-incompatible package', () => {
        const closure = importClosure(WORKERS_ENTRY);
        const offenders = sorted(closure.external).filter((s) => WORKERS_FORBIDDEN.test(s));

        // eslint-disable-next-line no-console
        console.info(
            `[export-surface] ${WORKERS_ENTRY} closure: ${closure.files.size} files, ` +
                `${closure.external.size} external specifier(s): ${sorted(closure.external).join(', ') || 'none'}`,
        );

        expect(
            offenders,
            `${WORKERS_ENTRY} transitively imports ${offenders.join(', ')}.\n` +
                'These depend on URL.createObjectURL / worker_threads, which Cloudflare ' +
                'Workers does not expose — the CF build will break at runtime with no ' +
                'build-time signal. Use src/workers/groth16-verifier.ts (which drives ' +
                'bn128.wasm directly) instead, or move the offending module out of the ' +
                'workers entry graph.',
        ).toEqual([]);
    });

    it('has no unresolvable dynamic imports that could smuggle one in', () => {
        const closure = importClosure(WORKERS_ENTRY);
        expect(
            closure.nonLiteralDynamicImports,
            'These files use `import(expr)` with a non-literal specifier, so the check ' +
                'above cannot see through them:\n' +
                `${bullets(closure.nonLiteralDynamicImports)}\n` +
                'Make the specifier a string literal, or the no-snarkjs invariant has a hole.',
        ).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. BUILT ARTIFACTS  (skipped on a clean checkout — `dist/` is gitignored)
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!hasBuild)('built artifacts', () => {
    it(`${DTS} values match ${BROWSER_JS} exports exactly`, () => {
        const dts = artifactSurface(DTS);
        const browser = artifactSurface(BROWSER_JS);

        const typedButAbsent = only(dts.values, browser.values);
        const shippedButUntyped = only(browser.values, dts.values);

        expect(
            { typedButAbsent, shippedButUntyped },
            'The rolled typings and the browser bundle disagree.\n' +
                (typedButAbsent.length
                    ? `  Declared in ${DTS} but NOT exported by ${BROWSER_JS} ` +
                      `(consumers get \`undefined\` at runtime):\n${bullets(typedButAbsent)}\n`
                    : '') +
                (shippedButUntyped.length
                    ? `  Exported by ${BROWSER_JS} but missing from ${DTS} ` +
                      `(consumers cannot import it in TypeScript):\n${bullets(shippedButUntyped)}\n`
                    : '') +
                'Both are built from the same entry, so this should be empty. Rebuild ' +
                '(`yarn build`) before investigating — a stale dist/ also fails here.',
        ).toEqual({ typedButAbsent: [], shippedButUntyped: [] });
    });

    it(`${WORKERS_JS} exports are all declared in ${DTS}`, () => {
        const dts = artifactSurface(DTS);
        const workers = artifactSurface(WORKERS_JS);
        const undeclared = only(workers.values, dts.values);

        expect(
            undeclared,
            `${WORKERS_JS} exports symbols that ${DTS} never declares:\n${bullets(undeclared)}\n` +
                'package.json points `types` at that one d.ts for the `workerd` condition ' +
                'too, so these are untyped for every Workers consumer.',
        ).toEqual([]);
    });

    /**
     * THE WORKERD LIE — recorded, deliberately NOT asserted.
     *
     * `package.json` resolves the `workerd` condition to `dist/workers/index.js`
     * (29 value exports) but still hands it `dist/connect.d.ts` (204 values,
     * rolled from the BROWSER entry). So a Workers consumer is told ~175 symbols
     * exist that are simply not in their bundle: `Client`, `AuthClient`,
     * `FileStorage` and the rest all typecheck and then blow up at runtime.
     *
     * There is no assertion here because there is nothing the SDK can currently
     * do to satisfy one — closing this needs a second rolled declaration file,
     * `dist/connect.workers.d.ts`, wired into the `workerd` export condition.
     * When that lands, turn the `it.todo` below into a real assertion that the
     * gap is zero.
     */
    // The workerd lie, now closed and gated. Before dist/connect.workers.d.ts
    // existed, a single connect.d.ts served every export condition and told a
    // workerd consumer that 175 symbols were available — Client, KvNamespace,
    // FileStorage, AuthClient among them — while dist/workers/index.js exports
    // 29, none of which is Client. Compile-time green, runtime
    // `undefined is not a constructor`.
    it(`${WORKERS_DTS} matches ${WORKERS_JS} exactly`, () => {
        const dts = artifactSurface(WORKERS_DTS);
        const js = artifactSurface(WORKERS_JS);

        const declaredNotShipped = only(dts.values, js.values);
        const shippedNotDeclared = only(js.values, dts.values);

        expect(
            { declaredNotShipped, shippedNotDeclared },
            `${WORKERS_DTS} and ${WORKERS_JS} disagree.\n` +
                (declaredNotShipped.length
                    ? `  DECLARED BUT NOT SHIPPED (the workerd lie returning):\n${bullets(declaredNotShipped)}\n`
                    : '') +
                (shippedNotDeclared.length
                    ? `  SHIPPED BUT NOT DECLARED (usable at runtime, untypeable):\n${bullets(shippedNotDeclared)}\n`
                    : ''),
        ).toEqual({ declaredNotShipped: [], shippedNotDeclared: [] });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. SURFACE SNAPSHOT
// ═════════════════════════════════════════════════════════════════════════════

const SNAPSHOT_HEADER = [
    '# Public export surface of src/browser/index.ts — GENERATED, do not hand-edit.',
    '#',
    '# Regenerate:  UPDATE_API_SURFACE=1 npx vitest --run tests/api/export-surface.test.ts',
    '#',
    '# READ THE DIFF, DO NOT RUBBER-STAMP IT. Every line here is a name a consumer',
    '# can import from `@muhkoo/connect`. An added line is new public API you are',
    '# committing to support; a removed line is a breaking change for someone.',
    '#',
    '#   V <name>   value  — exists at runtime',
    '#   T <name>   type   — erased at runtime, importable only as a type',
];

function renderSnapshot(surface: Surface): string {
    const lines = [
        ...sorted(surface.values).map((n) => `V ${n}`),
        ...sorted(surface.types).map((n) => `T ${n}`),
    ].sort();
    return `${[...SNAPSHOT_HEADER, '', ...lines].join('\n')}\n`;
}

/** Body lines only — the `#` header is documentation, not part of the surface. */
const snapshotBody = (text: string) =>
    text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

describe('surface snapshot', () => {
    it(`matches ${SNAPSHOT}`, () => {
        const surface = sourceSurface(BROWSER_ENTRY);
        const rendered = renderSnapshot(surface);
        const file = abs(SNAPSHOT);

        if (process.env.UPDATE_API_SURFACE === '1') {
            writeFileSync(file, rendered, 'utf8');
            // eslint-disable-next-line no-console
            console.info(`[export-surface] wrote ${SNAPSHOT} (${snapshotBody(rendered).length} names)`);
            return;
        }

        expect(
            existsSync(file),
            `${SNAPSHOT} is missing. It is a committed artifact, not a cache — regenerate ` +
                'it with UPDATE_API_SURFACE=1 and commit the result.',
        ).toBe(true);

        const actual = snapshotBody(rendered);
        const committed = snapshotBody(readFileSync(file, 'utf8'));
        const added = actual.filter((l) => !committed.includes(l));
        const removed = committed.filter((l) => !actual.includes(l));

        expect(
            actual,
            `The public surface of ${BROWSER_ENTRY} changed.\n` +
                (added.length ? `  ADDED (new public API):\n${bullets(added)}\n` : '') +
                (removed.length ? `  REMOVED (breaking for consumers):\n${bullets(removed)}\n` : '') +
                `\nIf every line above is intended, regenerate with:\n` +
                `  UPDATE_API_SURFACE=1 npx vitest --run tests/api/export-surface.test.ts\n` +
                'Then READ THE RESULTING DIFF — do not rubber-stamp it. Each line is a ' +
                'name consumers import from `@muhkoo/connect`.',
        ).toEqual(committed);
    });
});
