/**
 * Errors specific to the offline layer.
 */

/**
 * Thrown when an offline read/write needs the user's identity (to decrypt or
 * re-encrypt cached data) but the client is locked — typically right after a
 * reload, where only the session token was restored and `unlock()` hasn't run
 * yet. Distinct from the generic "not signed in" identity error so apps can
 * specifically prompt the user to unlock to see their offline data.
 */
export class OfflineLockedError extends Error {
    constructor(message = "Unlock required to access encrypted offline data. Call client.auth.zk.unlock(password).") {
        super(message);
        this.name = "OfflineLockedError";
    }
}
