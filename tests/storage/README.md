# Storage Tests

Tests for `src/storage/Storage.ts` — a Reed-Solomon-encoded storage layer
that uses the legacy `Network` class as its transport.

> **Heads up.** Neither `Storage` nor `Network` is exported from any of the
> three build targets (`browser`, `server`, `workers`). They're internal
> classes that the rest of the SDK doesn't surface anymore. These tests
> still exercise them in source form (`import { Storage } from
> '../../src/storage/Storage'`), so they remain useful as a working contract
> for those modules — but they don't reflect the public API.

## Test files

### `Storage.unit.test.ts` — fast, reliable

Unit tests against the `Storage` constructor + configuration without
exercising the actual Reed-Solomon encoder. Runs in milliseconds.

```bash
yarn vitest tests/storage/Storage.unit.test.ts
```

Covers:

- Constructor / option validation
- Network instance wiring
- Custom shard configuration
- `destroy()` resource cleanup
- Type definitions

### `Storage.test.ts` — integration (slow, may hang)

Full read/write cycle including Reed-Solomon encoding via worker threads.
~15 seconds per test on a warm machine. Has historically hung in some test
environments when the worker thread couldn't initialize.

```bash
yarn vitest tests/storage/Storage.test.ts
```

Covers:

- Write with real Reed-Solomon encoding
- FileStat metadata preservation
- Network message structure / chunk metadata
- Error handling (upload/download failures)
- Edge cases (empty data, single byte, blob)

### `abstractstorage.spec.ts`

Tests for the `AbstractStorage` base class.

### `encoding/`, `objects/`

Sub-suites for the Reed-Solomon encoder and stored-object types.

## Running

```bash
yarn vitest tests/storage/                  # everything in this folder
yarn vitest tests/storage/Storage.unit.test.ts  # fast unit subset
```

The project's root `vitest.config.ts` is what these run under — no parallel
configs needed.

## Known issues

1. **Integration tests may hang.** The Reed-Solomon encoder uses worker
   threads (`src/storage/encoding/ReedSolomon/NodeWorker.ts` /
   `RsEncodeDecodeWorker.cjs`) which sometimes fail to initialize under
   certain Vitest worker-pool configurations. If you hit a hang, fall back
   to the unit tests.
2. **Worker cleanup matters.** Always call `storage.destroy()` in
   `afterEach` to terminate worker threads cleanly.

## Troubleshooting hangs

1. Verify `src/storage/encoding/ReedSolomon/RsEncodeDecodeWorker.cjs`
   exists (it does today).
2. Make sure `__dirname` resolves correctly in your test environment.
3. Run only `Storage.unit.test.ts` for quick validation.
4. Consider mocking the encoder if you only care about the high-level flow.

## Status of `Storage` itself

`Storage` is not exported from the public build, but the code still
compiles and the tests still pass. If/when the SDK formally drops this
module, these tests can go with it.
