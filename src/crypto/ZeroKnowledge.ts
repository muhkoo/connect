import {
    Field,
    Poseidon,
    Provable,
    ZkProgram,
    Struct,
} from 'o1js';

interface ZkCompiled {
    verificationKey: {
        data: string;
        hash: Field;
    };
}

// Define public input struct
class AuthPublicInput extends Struct({
    commitment: Field,
    nonce: Field,
    ecdsaPubHash: Field, // Hash of ECDSA public key
}) { }

// Encoding: BigInt to hex string
export function encodeToHex(field: Field): string {
    return '0x' + field.toBigInt().toString(16).padStart(64, '0');  // Pad to 64 chars for full 256 bits
}

// Decoding: Hex string back to Field
export function decodeFromHex(hexStr: string): Field {
    if (!hexStr.startsWith('0x')) throw new Error('Invalid hex prefix');
    const bigIntValue = BigInt(hexStr);
    return Field(bigIntValue);
}

// Define a zk program to prove knowledge of a secret that hashes to a public value
const HashKnowledge = ZkProgram({
    name: 'HashKnowledge',
    publicOutput: Field,
    methods: {
        proveKnowledge: {
            privateInputs: [Field],
            async method(secret: Field) {
                // Compute hash inside the proof
                const hash = Poseidon.hash([secret]);
                // Log for debugging (runs during proof generation)
                Provable.log('Computed hash:', hash);
                return { publicOutput: hash };
            },
        },
    },
});

const PreimagePoK = ZkProgram({
    name: 'PreimagePoK',
    publicInput: AuthPublicInput,
    methods: {
        proveKnowledge: {
            privateInputs: [Field, Field, Field], // secret, salt, ecdsaPub
            async method(publicInput: AuthPublicInput, secret: Field, salt: Field, ecdsaPub: Field) {
                const computedCommitment = Poseidon.hash([secret, salt, Poseidon.hash([ecdsaPub])]);
                computedCommitment.assertEquals(publicInput.commitment);
                Poseidon.hash([ecdsaPub]).assertEquals(publicInput.ecdsaPubHash);
                Provable.log('Commitment matches, proof bound to nonce:', publicInput.nonce);
            },
        },
    },
});

export { HashKnowledge, PreimagePoK, AuthPublicInput, ZkCompiled };