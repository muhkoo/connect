/**
 * Absolute POSIX paths for the VFS.
 *
 * A path is a lookup route, not a stored value: nothing in the metadata records
 * a full path, only a name inside its parent directory. That is what makes
 * renaming or moving a directory a single-record edit instead of a rewrite of
 * every descendant.
 */

/** Absolute, single leading slash, no `.` / `..`, no trailing slash. Root is `/`. */
export function normalizePath(input: string): string {
    const out: string[] = [];
    for (const part of input.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    return "/" + out.join("/");
}

/** Path split into its segments. `/` yields `[]`. */
export function segments(path: string): string[] {
    return normalizePath(path).split("/").filter(Boolean);
}

/**
 * Resolve `path` against a working directory, POSIX-style.
 *
 * An absolute path ignores the cwd; a relative one hangs off it; `..` climbs
 * and stops at the root rather than escaping it. This is the single place
 * relativity is interpreted, so every VFS method behaves the same way — a
 * filesystem where `cat a.txt` and `list("a")` disagreed about what "here"
 * means would be worse than having no cwd at all.
 */
export function resolveFrom(cwd: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${cwd}/${path}`);
}

export function dirname(path: string): string {
    const p = normalizePath(path);
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(path: string): string {
    const p = normalizePath(path);
    return p.slice(p.lastIndexOf("/") + 1);
}

export function join(...parts: string[]): string {
    return normalizePath(parts.join("/"));
}

/**
 * Is `path` inside `dir` (at any depth)? A directory is never "under" itself,
 * which is what makes it usable as the guard against moving a directory into
 * its own subtree.
 */
export function isUnder(path: string, dir: string): boolean {
    const p = normalizePath(path);
    const d = normalizePath(dir);
    if (p === d) return false;
    return d === "/" ? true : p.startsWith(d + "/");
}

/**
 * Reject names that would make a path ambiguous or unrepresentable.
 *
 * `/` would forge a nesting level, and `.` / `..` would resolve to a different
 * directory on the next lookup — a file literally named `..` could never be
 * addressed again.
 */
/** The longest a single entry name may be. Matches the common filesystem limit. */
export const MAX_NAME_BYTES = 255;

/**
 * Is this a name we are willing to store, and to hand back as a path segment?
 *
 * This is the READ-side check as much as the write-side one, and the read side
 * is the one that matters: a directory record is sealed with a key that any
 * holder of the master seed can derive, so its contents are not necessarily
 * something this SDK wrote. A name arriving from a record is input.
 *
 * What each rule is for:
 *  - `/` and backslash would become path structure. Backslash is a separator on
 *    Windows, which makes it traversal there and an odd filename elsewhere.
 *  - `.` and `..` navigate rather than name.
 *  - NUL terminates a path in every syscall that takes one.
 *  - Other control characters and bidi overrides let a name print as something
 *    other than what it is - the classic way a file passes review.
 *  - A length cap, because nothing else imposes one.
 */
export function isSafeName(name: string): boolean {
    if (!name || name === "." || name === "..") return false;
    if (name.includes("/") || name.includes(String.fromCharCode(92))) return false;
    const CONTROL_OR_BIDI = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]");
    if (CONTROL_OR_BIDI.test(name)) return false;
    return new TextEncoder().encode(name).length <= MAX_NAME_BYTES;
}

export function assertValidName(name: string): void {
    if (!name) throw new Error("VFS: name cannot be empty");
    if (!isSafeName(name)) throw new Error(`VFS: ${JSON.stringify(name)} is not a usable name`);
}

/**
 * MIME type for a filename.
 *
 * Stored with the content rather than guessed at read time, because whatever
 * eventually serves these bytes — a preview, a static host — sends this as the
 * `Content-Type`, and a browser will refuse to run a module or apply a
 * stylesheet labelled `application/octet-stream`.
 */
export function contentTypeFor(name: string): string {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    switch (ext) {
        case "html": case "htm": return "text/html; charset=utf-8";
        case "css": return "text/css; charset=utf-8";
        case "js": case "mjs": case "jsx": return "text/javascript; charset=utf-8";
        case "ts": case "tsx": return "text/typescript; charset=utf-8";
        case "json": return "application/json; charset=utf-8";
        case "md": return "text/markdown; charset=utf-8";
        case "txt": return "text/plain; charset=utf-8";
        case "svg": return "image/svg+xml";
        case "png": return "image/png";
        case "jpg": case "jpeg": return "image/jpeg";
        case "gif": return "image/gif";
        case "webp": return "image/webp";
        case "avif": return "image/avif";
        case "ico": return "image/x-icon";
        case "woff2": return "font/woff2";
        case "woff": return "font/woff";
        case "wasm": return "application/wasm";
        case "map": return "application/json";
        default: return "application/octet-stream";
    }
}
