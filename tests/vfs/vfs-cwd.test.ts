import { describe, it, expect } from "vitest";
import { makeVfs } from "./harness";
import { VfsConflictError, VfsNotFoundError } from "../../src/vfs/types";

describe("VFS — working directory", () => {
    it("starts at the root", async () => {
        const { vfs } = makeVfs();
        expect(vfs.cwd).toBe("/");
    });

    it("resolves relative paths against the cwd", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/apps/scratch/src/App.tsx", "source");

        await vfs.cd("/apps/scratch");
        expect(vfs.cwd).toBe("/apps/scratch");
        expect(await vfs.readText("src/App.tsx")).toBe("source");
        expect((await vfs.list()).map((e) => e.name)).toEqual(["src"]);
        expect(await vfs.walk()).toEqual(["/apps/scratch/src/App.tsx"]);
    });

    it("leaves absolute paths alone wherever you are", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/top.txt", "top");
        await vfs.mkdir("/deep/nested", { recursive: true });

        await vfs.cd("/deep/nested");
        expect(await vfs.readText("/top.txt")).toBe("top");
    });

    it("climbs with .. and stops at the root", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/apps/a.txt", "a");
        await vfs.mkdir("/apps/scratch/src", { recursive: true });

        await vfs.cd("/apps/scratch/src");
        expect(await vfs.readText("../../a.txt")).toBe("a");

        await vfs.cd("..");
        expect(vfs.cwd).toBe("/apps/scratch");
        // `..` past the root is the root, never an escape.
        await vfs.cd("/");
        await vfs.cd("../../..");
        expect(vfs.cwd).toBe("/");
    });

    it("cds relatively", async () => {
        const { vfs } = makeVfs();
        await vfs.mkdir("/apps/scratch/src", { recursive: true });
        await vfs.cd("/apps");
        await vfs.cd("scratch/src");
        expect(vfs.cwd).toBe("/apps/scratch/src");
    });

    it("refuses to cd somewhere that is not a directory", async () => {
        // Failing here names the path; failing later turns every relative path
        // into a confusing "does not exist".
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        await expect(vfs.cd("/a.txt")).rejects.toThrow(VfsConflictError);
        await expect(vfs.cd("/nope")).rejects.toThrow(VfsNotFoundError);
        expect(vfs.cwd).toBe("/");   // a failed cd must not move you
    });

    it("writes, copies and deletes relative to the cwd", async () => {
        const { vfs } = makeVfs();
        await vfs.mkdir("/apps/scratch", { recursive: true });
        await vfs.cd("/apps/scratch");

        await vfs.writeFile("notes.md", "hello");
        expect(await vfs.readText("/apps/scratch/notes.md")).toBe("hello");

        await vfs.copy("notes.md", "notes-copy.md");
        await vfs.rename("notes-copy.md", "renamed.md");
        expect((await vfs.list()).map((e) => e.name)).toEqual(["notes.md", "renamed.md"]);

        await vfs.delete("renamed.md");
        expect(await vfs.exists("/apps/scratch/renamed.md")).toBe(false);
    });

    it("globs relative to the cwd", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/apps/a/x.ts", "");
        await vfs.writeFile("/apps/b/y.ts", "");
        await vfs.cd("/apps/b");
        expect(await vfs.glob("*.ts")).toEqual(["/apps/b/y.ts"]);
    });

    it("resets to the root when the cache is cleared", async () => {
        // clearCache runs on identity change, and another identity's tree has
        // entirely different directories — staying in the old path would resolve
        // relative paths somewhere meaningless.
        const { vfs } = makeVfs();
        await vfs.mkdir("/apps");
        await vfs.cd("/apps");
        vfs.clearCache();
        expect(vfs.cwd).toBe("/");
    });
});
