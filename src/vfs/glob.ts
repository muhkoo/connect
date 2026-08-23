/**
 * Glob matching for VFS paths.
 *
 * A deliberately small dialect — `*`, `**`, `?`, and `{a,b}` — because these
 * cover what a project actually asks for (`**\/*.tsx`, `src/*.css`) and every
 * addition beyond them is a new way for a pattern to mean something the caller
 * did not expect.
 */

/** `*` stops at a separator; `**` crosses them. That distinction is the whole point. */
export function globToRegExp(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                // `**/` should also match zero directories, so `/**/x` finds `/x`.
                if (pattern[i + 2] === "/") {
                    out += "(?:.*/)?";
                    i += 2;
                } else {
                    out += ".*";
                    i += 1;
                }
            } else {
                out += "[^/]*";
            }
        } else if (c === "?") {
            out += "[^/]";
        } else if (c === "{") {
            const close = pattern.indexOf("}", i);
            if (close === -1) {
                out += "\\{";
            } else {
                const alts = pattern.slice(i + 1, close).split(",");
                out += `(?:${alts.map(escapeLiteral).join("|")})`;
                i = close;
            }
        } else {
            out += escapeLiteral(c);
        }
    }
    return new RegExp(`^${out}$`);
}

function escapeLiteral(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
