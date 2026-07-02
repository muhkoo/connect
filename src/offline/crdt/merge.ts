/**
 * Barrel for the CRDT layer. One import surface for the merge primitives so the
 * namespaces and the sync engine don't reach into individual files. Each domain
 * picks the CRDT that fits it:
 *
 *   - kv value / app snapshot → {@link LwwRegister} (whole-value LWW)
 *   - db row                  → {@link LwwMap} (per-column LWW + row tombstone)
 *   - space message           → {@link MessageEntry} (handle-ordered grow-only log)
 *
 * deletes everywhere ride the causal tombstone rules in {@link ./ORSet}.
 */

export * from "./LWWRegister";
export * from "./LWWMap";
export * from "./ORSet";
export * from "./MessageLog";
