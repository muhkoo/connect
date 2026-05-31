/**
 * `Room` — backwards-compatible alias for {@link Space}.
 *
 * The shared-space handle was renamed `Room` → `Space` once every primitive in
 * the SDK became a "space". The class moved to `src/spaces/Space.ts`; this
 * module preserves the historical `Room` / `RoomDeps` / `RoomFileMetadata`
 * names so existing imports (and the in-tree web app) keep resolving unchanged.
 *
 * New code should import `Space` from `../spaces`.
 */

import { Space, type SpaceDeps, type SpaceFileMetadata } from "../spaces/Space";

export { Space as Room };
export type { SpaceDeps as RoomDeps, SpaceFileMetadata as RoomFileMetadata };

export default Space;
