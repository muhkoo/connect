// import { base58Decode, base58Encode, serialize, deserialize } from "../utilities";
const { subtle } = globalThis.crypto;
// export interface DehydratedKeys {
//     public: string;
//     private: string;
// }

export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
    // Generate ECDH key pair with P-384
    const keyPair: CryptoKeyPair = await subtle.generateKey(
        {
            name: 'ECDH',
            namedCurve: 'P-384' // P-384 curve for strong security
        },
        true, // Extractable for dehydration
        ['deriveKey'] // For shared secret derivation
    );

    return keyPair;
}

// export async function encryptMessage(message: string, key: CryptoKey): Promise<ArrayBuffer> {
//     const encoder = new TextEncoder();
//     // Generate a random 12-byte IV for AES-GCM
//     const iv = crypto.getRandomValues(new Uint8Array(12));
//     // Encrypt the message
//     const encryptedMessage = await globalThis.crypto.subtle.encrypt(
//         {
//             name: 'AES-GCM',
//             iv: iv,
//         },
//         key,
//         encoder.encode(message)
//     );
//     // Combine IV and encrypted data into a single ArrayBuffer
//     const combined = new Uint8Array(iv.length + encryptedMessage.byteLength);
//     combined.set(iv, 0);
//     combined.set(new Uint8Array(encryptedMessage), iv.length);
//     return combined.buffer;
// }

// export async function decryptMessage(encryptedMessage: ArrayBuffer, key: CryptoKey): Promise<string> {
//     const iv = new Uint8Array(encryptedMessage.slice(0, 12)); // Extract IV from the beginning of the encrypted message
//     const decryptedMessage = await globalThis.crypto.subtle.decrypt(
//         {
//             name: 'AES-GCM',
//             iv: iv,
//         },
//         key,
//         encryptedMessage.slice(12) // The rest is the actual encrypted data
//     );
//     return new TextDecoder().decode(decryptedMessage);
// }

// export async function dehydrateKeyPair(keyPair: CryptoKeyPair): Promise<DehydratedKeys> {
//     const publicKey = await subtle.exportKey('jwk', keyPair.publicKey);
//     const privateKey = await subtle.exportKey('jwk', keyPair.privateKey);
//     const publicKeyBase64 = JSON.stringify(publicKey);
//     const privateKeyBase64 = JSON.stringify(privateKey);
//     return { public: serialize(publicKeyBase64.replace(/=+$/, '')), private: serialize(privateKeyBase64.replace(/=+$/, '')) };
// }

// export async function hydrateKeyPair(dehydratedKeys: DehydratedKeys): Promise<CryptoKeyPair> {
//     return hydrateKey(dehydratedKeys.public, dehydratedKeys.private);
// }

// export async function hydrateKey(publicKeyBase58: string, privateKeyBase58: string): Promise<CryptoKeyPair> {
//     // Convert base64 back to binary
//     let publicKeyBase64: JsonWebKey = JSON.parse(deserialize(publicKeyBase58));
//     let privateKeyBase64: JsonWebKey = JSON.parse(deserialize(privateKeyBase58));
//     // Hydrate: Import keys with P-384
//     const publicKey: CryptoKey = await subtle.importKey(
//         'jwk',
//         publicKeyBase64,
//         { name: 'ECDH', namedCurve: 'P-384' },
//         false, // Not extractable
//         [] // No usages for public key
//     );

//     const privateKey: CryptoKey = await subtle.importKey(
//         'jwk',
//         privateKeyBase64,
//         { name: 'ECDH', namedCurve: 'P-384' },
//         true, // Extractable (if needed later)
//         ['deriveKey']
//     );
//     return { publicKey, privateKey };
// }

// export function deriveSecretKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
//     return globalThis.crypto.subtle.deriveKey(
//         {
//             name: "ECDH",
//             public: publicKey,
//         },
//         privateKey,
//         {
//             name: "AES-GCM",
//             length: 256,
//         },
//         false,
//         ["encrypt", "decrypt"],
//     );
// }
