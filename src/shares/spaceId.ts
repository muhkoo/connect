/**
 * What a share's Space id may be. SDK-internal: not exported from `src/shares/index.ts`.
 *
 * A Space id the SDK makes is its P-384 public key as a base64url JWK, 256 characters
 * (`spaces/SpaceCipher.ts`). The accelerator accepts a share id of 1 to 300 base64url characters
 * (`isValidShareSpaceId`): no `:` (its `shareof:<username>:<spaceId>` cache keys stay unambiguous) and no `/`
 * (the id is a URL path segment as it stands). The SDK checks the same rule, so an id it accepts is one the
 * server routes.
 */

/** Longest share id the accelerator accepts. */
export const SHARE_SPACE_ID_MAX = 300;

/** One share id, unanchored, for building larger patterns. */
export const SHARE_SPACE_ID_PATTERN = `[A-Za-z0-9_-]{1,${SHARE_SPACE_ID_MAX}}`;

/** A whole string that is a share id. */
export const SHARE_SPACE_ID = new RegExp(`^${SHARE_SPACE_ID_PATTERN}$`);
