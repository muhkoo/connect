import { describe, it, expect } from "vitest";
import { makeVfs, makeStore, makeContent } from "./harness";
import { VfsConflictError, VfsNotFoundError } from "../../src/vfs/types";
import { VfsNamespace, type VfsContentStore } from "../../src/vfs/VfsNamespace";

describe("VFS — statManifest", () => {
    it("returns the manifest that reads the current version", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/docs/a.txt", "v1");
        await vfs.writeFile("/docs/a.txt", "version two");

        const h = await vfs.statManifest("/docs/a.txt");

        expect(h.size).toBe("version two".length);
        expect(new TextDecoder().decode(await vfs.readByManifest(h.manifest))).toBe("version two");
    });

    it("resolves relative paths against the cwd", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/docs/a.txt", "x");
        await vfs.cd("/docs");
        expect((await vfs.statManifest("a.txt")).size).toBe(1);
    });

    it("throws VfsConflictError for a directory and VfsNotFoundError for a missing path", async () => {
        const { vfs } = makeVfs();
        await vfs.mkdir("/docs");
        await expect(vfs.statManifest("/docs")).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.statManifest("/nope.txt")).rejects.toBeInstanceOf(VfsNotFoundError);
    });
});

describe("VFS — writeFile progress", () => {
    it("passes onProgress through to the content store", async () => {
        const base = makeContent();
        const seen: Array<[number, number]> = [];
        const content: VfsContentStore = {
            ...base,
            async write(data, meta, opts) {
                opts?.onProgress?.(1, 2);
                opts?.onProgress?.(2, 2);
                return base.write(data, meta);
            },
        };
        const vfs = new VfsNamespace({ store: makeStore(), content, seed: () => new Uint8Array(32).fill(7) });

        await vfs.writeFile("/a.txt", "hi", { onProgress: (done, total) => seen.push([done, total]) });

        expect(seen).toEqual([[1, 2], [2, 2]]);
    });

    it("still writes when no callback is given", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "hi");
        expect(await vfs.readText("/a.txt")).toBe("hi");
    });
});
