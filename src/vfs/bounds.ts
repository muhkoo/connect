/**
 * Bounds shared by the VFS walkers and version control's history walks.
 *
 * Internal: `src/api.ts` re-exports everything in `VfsNamespace.ts`, and none
 * of this is public API.
 */

/**
 * How deep a tree may be before a walk refuses it, counted in directories
 * below where the walk starts - and how deep, counted from the root, any
 * directory may be written.
 *
 * Well past anything a real project needs. Refusing means THROWING a
 * VfsLimitError: this used to stop quietly and return the shallower part,
 * which a sync reads as "everything deeper was deleted". Writes are held to it
 * from the root so that no walk, from anywhere, is refused a tree this SDK
 * wrote; version control holds a checkout to it too.
 */
export const MAX_DEPTH = 64;

/**
 * The most entries one walk, copy or read of history may visit, unless the
 * namespace was constructed with other limits.
 *
 * A cycle guard cannot bound a walk on its own: records can name the same
 * directory twice without any cycle (D0 -> {a, b} -> D1 -> {a, b} -> ...), and
 * every level doubles the paths - sixty-four levels of that is 2^64 paths from
 * sixty-four tiny records. Repository trees are the same: every hash can be
 * genuine and each level still double the paths. A tree past the budget is
 * thrown on rather than half-read.
 *
 * Half a million is a very large real project. It was a million, which fits
 * one walk in a 512MB heap, but `vcs status` holds a commit's paths and the
 * working tree's changes at once, both chosen by whoever planted them: two
 * sides of a million, every path a change, is two million paths of output,
 * and ended within 9MB of a 512MB heap even compared as it was walked.
 */
export const DEFAULT_MAX_ENTRIES = 500_000;

/**
 * The most characters of path text one walk or read of history may produce,
 * summed over its paths.
 *
 * The entry budget alone does not bound memory, because the attacker chooses
 * how big each entry is: a name may be 255 bytes and a tree 64 levels deep, so
 * one path can be ~16KB, and every path is its own string. Forty-odd small
 * records of long names stayed under the entry budget and still asked for
 * ~11GB. This allows an average of 64 characters a path at the entry
 * ceiling - 32MB of text, or 64MB in names a JS engine stores two bytes a
 * character - which a real project reaches only if it is near that ceiling
 * anyway.
 */
export const DEFAULT_MAX_PATH_CHARS = 64 * DEFAULT_MAX_ENTRIES;

/** The furthest from 1970, either way, a Date can be, in milliseconds. */
export const MAX_TIME = 8.64e15;

/**
 * Directory records one walk fetches at once - in TOTAL, not per directory.
 *
 * Sized for the network, not for memory. What ran a walk out of memory was
 * in-flight VISITS over cached records, and the walk now visits one
 * directory at a time; this bounds FETCHES, each holding at most one record -
 * 128MB sealed if all 64 are as big as a Durable Object value may be. Every
 * get is its own request, and a cold walk of D directories costs at least
 * D / WALK_CONCURRENCY round trips on top of one per level: at 30ms a get, a
 * 333-directory project took 1.46s with 8, 0.49s with 32 and 0.37s with 64,
 * against 0.25s for the old walk, which had up to 225 gets in flight on the
 * same tree. Separate from FileStorage's shard concurrency, which it once
 * matched: shards are batched, and records are not.
 */
export const WALK_CONCURRENCY = 64;

/**
 * How many entries a walk visits between turns of the event loop.
 *
 * Once its records are cached a walk never waits on anything, and a chain of
 * promise continuations runs to the end before any timer, input event or
 * signal handler is let in. A few hundred thousand entries is seconds of that:
 * a frozen tab, or a `vfs mount` that ignores Ctrl-C. Each turn costs a
 * fraction of a millisecond, which at this spacing a real project never
 * notices. Version control's history walks use it too.
 */
export const YIELD_EVERY = 8192;

/**
 * Let the event loop run - timers, I/O, input, signal handlers - before
 * carrying on.
 *
 * `setImmediate` is Node's turn of the loop, and a MessageChannel message is
 * a browser's: a task queued behind whatever is already waiting, which is
 * the point. Not `scheduler.yield()`, although Chromium has it: its
 * continuation is scheduled AHEAD of tasks already queued at the same
 * priority, and timers, postMessage and socket messages are such tasks - a
 * cached walk yielding through it gave a 1ms interval no ticks in 2s. And a
 * bare `setTimeout(0)` only when there is nothing else: a browser clamps a
 * timer set from inside another to 4ms, and in a hidden tab runs it about
 * once a second, or once a minute after five minutes hidden.
 *
 * In Node a MessagePort with a listener would also keep the process alive,
 * which is one more reason `setImmediate` comes first.
 */
export function nextTurn(): Promise<void> {
    const g = globalThis as { setImmediate?: (callback: () => void) => unknown };
    if (typeof g.setImmediate === "function") return new Promise((resolve) => g.setImmediate!(resolve));
    if (typeof MessageChannel === "function") {
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                resolve();
            };
            channel.port2.postMessage(null);
        });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}
