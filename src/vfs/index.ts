export { VfsNamespace, type VfsNamespaceDeps, type VfsContentStore } from "./VfsNamespace";
export {
    VfsLockedError,
    VfsNotFoundError,
    VfsConflictError,
    type VfsStat,
    type VfsStore,
    type DirNode,
    type FileEntry,
    type DirEntry,
    type Entry,
} from "./types";
export { globToRegExp } from "./glob";
export { resolveFrom, normalizePath, dirname, basename, join, isUnder, segments } from "./paths";
