# Storage Tests

This directory contains tests for the Storage class which provides Reed-Solomon encoded data storage via REST API.

## Test Files

### `Storage.unit.test.ts` ✅ Fast, Reliable
**Recommended for CI/CD and quick validation**

- **Purpose**: Unit tests for Storage class without actual encoding
- **Speed**: Very fast (~3ms)
- **Coverage**: Constructor, configuration, type validation, destroy method
- **No Dependencies**: Doesn't require worker threads or actual encoding

**Run with:**
```bash
npm test tests/storage/Storage.unit.test.ts
```

### `Storage.test.ts` ⚠️ Integration Tests (Slow)
**Use for full end-to-end validation**

- **Purpose**: Integration tests with actual Reed-Solomon encoding
- **Speed**: Slow (15+ seconds per test due to worker thread encoding)
- **Coverage**: Full write/read cycle with real encoding, network integration, error handling
- **Dependencies**: Requires worker threads and Reed-Solomon encoder

**Run with:**
```bash
npm test tests/storage/Storage.test.ts
```

**Note**: These tests may hang or timeout if the Reed-Solomon worker encounters issues. If tests hang, use the unit tests for validation.

## Test Coverage

### Unit Tests Cover:
- ✅ Constructor with various configurations
- ✅ Network instance validation
- ✅ Custom shard configuration
- ✅ Resource cleanup (destroy method)
- ✅ Type definitions

### Integration Tests Cover:
- ✅ Write operations with actual Reed-Solomon encoding
- ✅ FileStat metadata preservation
- ✅ Network message structure
- ✅ Chunk metadata (shards, parityShards, indexes)
- ✅ Error handling (upload failures, download failures)
- ✅ Edge cases (empty data, single byte, blob data)

## Running Tests

```bash
# Run just the fast unit tests
npm test tests/storage/Storage.unit.test.ts

# Run integration tests (slow, may hang)
npm test tests/storage/Storage.test.ts

# Run all storage tests
npm test tests/storage/
```

## Known Issues

1. **Integration tests may hang**: The Reed-Solomon encoder uses worker threads which may not properly initialize in test environments. This causes `encodeChunk()` promises to never resolve.

2. **Timeout warnings**: Integration tests have 15-second timeouts to account for encoding overhead. This is normal.

3. **Worker thread cleanup**: Make sure to call `storage.destroy()` in `afterEach` to properly terminate worker threads.

## Troubleshooting

If integration tests hang:
1. Check that `/Users/matt/GitHub/muhkoo/connect/src/storage/encoding/ReedSolomon/RsEncodeDecodeWorker.cjs` exists
2. Verify `__dirname` resolves correctly in your test environment
3. Run unit tests instead for quick validation
4. Consider mocking the ReedSolomon encoder for integration tests

## Future Improvements

- Mock the ReedSolomon encoder to avoid worker thread issues
- Add round-trip tests (write → read → verify) once decoding is stable
- Add performance benchmarks for encoding/decoding
- Test with larger files and multiple chunks
