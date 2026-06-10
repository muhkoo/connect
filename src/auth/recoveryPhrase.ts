/**
 * Recovery phrase (M1.2) — a 24-word BIP39 mnemonic that ENCODES the 32-byte
 * master seed directly. Nothing is stored server-side (the phrase *is* the seed),
 * so it's a fully offline, self-sovereign recovery factor: enter the phrase →
 * decode → master seed → identity. A `phrase-marker` factor is kept in the vault
 * only so the UI can show "recovery phrase: enabled".
 */

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Encode a 32-byte master seed as a 24-word BIP39 recovery phrase. */
export function seedToMnemonic(seed: Uint8Array): string {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("seedToMnemonic: expected a 32-byte seed");
  }
  return entropyToMnemonic(seed, wordlist);
}

function normalize(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Decode a recovery phrase back to the 32-byte master seed. Throws if invalid. */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  const m = normalize(mnemonic);
  if (!validateMnemonic(m, wordlist)) throw new Error("Invalid recovery phrase.");
  return mnemonicToEntropy(m, wordlist);
}

/** Whether `mnemonic` is a well-formed BIP39 phrase (checksum valid). */
export function isValidPhrase(mnemonic: string): boolean {
  try {
    return validateMnemonic(normalize(mnemonic), wordlist);
  } catch {
    return false;
  }
}
