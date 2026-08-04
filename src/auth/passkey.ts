/**
 * Passkey factor (M1.1) — WebAuthn with the **PRF extension**.
 *
 * A passkey becomes a device-bound, platform-synced source of a stable secret:
 * for a fixed salt, the authenticator's PRF returns the same 32 bytes, which we
 * HKDF into an AES key that wraps the master seed. The server never sees the
 * passkey — it's purely a local key source; the ZK proof remains the server auth.
 *
 * BROWSER ONLY (`navigator.credentials`). The PRF extension fields aren't in the
 * standard DOM types yet, so they're reached through narrow casts.
 */

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Whether this environment can do WebAuthn at all. (PRF support is checked at enroll.) */
export function passkeySupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.credentials &&
    typeof PublicKeyCredential !== "undefined"
  );
}

/**
 * Whether this browser's authenticator can do the **PRF extension** our passkey
 * factor needs. A browser can save passkeys (e.g. for password autofill) yet not
 * expose PRF — PRF is what derives the stable secret we wrap the seed under, so a
 * passkey without it is useless to us.
 *
 * Uses `PublicKeyCredential.getClientCapabilities()` (the `extension:prf` cap)
 * where available. Returns:
 *   - `true`  — PRF is supported,
 *   - `false` — definitively NOT supported (hide the option),
 *   - `null`  — couldn't determine (older browser without the capabilities API);
 *              the caller may optimistically allow and let enroll surface a real
 *              error if it turns out PRF isn't there.
 */
export async function passkeyPrfCapable(): Promise<boolean | null> {
  if (!passkeySupported()) return false;
  const PC = PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  };
  if (typeof PC.getClientCapabilities !== "function") return null;
  try {
    const caps = await PC.getClientCapabilities();
    // The spec keys extension caps as `extension:<name>`; tolerate variants.
    const prf = caps["extension:prf"] ?? caps["extensions:prf"] ?? caps["prf"];
    return typeof prf === "boolean" ? prf : null;
  } catch {
    return null;
  }
}

/** Best-effort registrable RP id — the host. Apps spanning subdomains should pass
 *  the parent domain (e.g. "muhkoo.dev") explicitly. */
export function defaultRpId(): string {
  return typeof location !== "undefined" ? location.hostname : "";
}

/**
 * Can a passkey enrolled under `rpId` be used from the CURRENT origin?
 *
 * WebAuthn only accepts an RP id that is the origin's own host or a registrable
 * *parent* of it — so a passkey enrolled on `app.example.com` is unusable on
 * `app.example.net`, and one enrolled on a full host is unusable from a sibling
 * host. An app served on BOTH a custom domain and the platform host therefore
 * needs one passkey per origin.
 *
 * Call this BEFORE `navigator.credentials.get()`: passing a foreign rpId throws
 * a raw "The requested RPID did not match the origin or related origins", which
 * is a dead end for the user. Checking first lets the caller fall back to normal
 * sign-in (and offer to enroll a passkey for this origin) instead.
 */
export function rpIdUsableForOrigin(rpId: string | undefined | null, host?: string): boolean {
  const h = host ?? (typeof location !== "undefined" ? location.hostname : "");
  if (!rpId || !h) return false;
  return h === rpId || h.endsWith(`.${rpId}`);
}

/** Thrown when the account's passkey belongs to a different origin. Callers
 *  should treat this as "no passkey here" and fall back to another factor. */
export class PasskeyOriginError extends Error {
  readonly code = "passkey_wrong_origin";
  constructor(message = "No passkey is enrolled for this site. Sign in another way, then add one for this device.") {
    super(message);
    this.name = "PasskeyOriginError";
  }
}

export interface PasskeyEnrollment {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  prfOutput: Uint8Array;
}

/**
 * Create a passkey with PRF and return its credential id, a fresh PRF salt, and
 * the PRF output for that salt. Throws if the authenticator can't do PRF.
 */
export async function createPasskeyWithPrf(opts: { rpId: string; rpName: string; username: string }): Promise<PasskeyEnrollment> {
  if (!passkeySupported()) throw new Error("Passkeys aren't supported in this browser.");
  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { id: opts.rpId, name: opts.rpName },
      user: { id: rand(16) as BufferSource, name: opts.username, displayName: opts.username },
      challenge: rand(32) as BufferSource,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      // Force the PLATFORM authenticator (Touch ID / Windows Hello / iCloud
      // Keychain). Our factor needs the PRF extension to wrap the seed, and
      // third-party browser password-manager extensions register as cross-platform
      // authenticators that often DON'T implement PRF — letting one handle the
      // request is the main cause of "didn't return a PRF result" failures. Pinning
      // to platform routes it to the OS authenticator, which supports PRF.
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "preferred" },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new Error("Passkey creation was cancelled.");
  const credentialId = new Uint8Array(created.rawId);
  // Don't trust `prf.enabled` from create() alone — several browsers only report
  // PRF support on the first get() eval, so a precheck false-negatives. Try the
  // actual PRF eval; if it yields a result, PRF works.
  const prfSalt = rand(32);
  let prfOutput: Uint8Array;
  try {
    prfOutput = await evaluatePasskeyPrf(opts.rpId, credentialId, prfSalt);
  } catch {
    // Empty PRF result almost always means a third-party credential manager
    // (e.g. a browser password-manager extension) handled the request instead of
    // the platform authenticator, and that manager doesn't implement PRF. The
    // device's built-in passkey (Touch ID / Windows Hello / iCloud Keychain)
    // normally does — so steer the user there rather than blaming the device.
    throw new Error(
      "That passkey can't be used for recovery — it didn't return a PRF result. " +
        "A browser password-manager extension may have handled it; try again and " +
        "pick your device's built-in passkey (Touch ID / Windows Hello), or use a " +
        "recovery phrase instead.",
    );
  }
  return { credentialId, prfSalt, prfOutput };
}

/** Evaluate a passkey's PRF for `salt` → 32 bytes. Used at recover/login. */
export async function evaluatePasskeyPrf(rpId: string, credentialId: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  if (!passkeySupported()) throw new Error("Passkeys aren't supported in this browser.");
  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: rand(32) as BufferSource,
      allowCredentials: [{ type: "public-key", id: credentialId as BufferSource }],
      userVerification: "preferred",
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("Passkey authentication was cancelled.");
  const results = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })?.prf?.results;
  if (!results?.first) throw new Error("Your passkey didn't return a PRF result.");
  return new Uint8Array(results.first);
}
