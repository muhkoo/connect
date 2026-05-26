import { prove as groth16Prove, verify as groth16Verify } from '@zk-kit/groth16';
import type { PublicSignals as Groth16PublicSignals } from '@zk-kit/groth16';
// Shared ZK types live in src/types/zk so the workers build (which can't pull
// in snarkjs) sees the same VerificationKey / Groth16Proof shapes used here.
import type { Groth16Proof, VerificationKey } from '../types/zk';

// Re-export so existing consumers of crypto/* keep working
export type SnarkProof = Groth16Proof;
export type { VerificationKey } from '../types/zk';

export interface ZkCompiled {
    verificationKey: VerificationKey;
}

// Authentication public input structure
export class AuthPublicInput {
    commitment: string;
    nonce: string;
    ecdsaPubHash: string;

    constructor(commitment: string, nonce: string, ecdsaPubHash: string) {
        this.commitment = commitment;
        this.nonce = nonce;
        this.ecdsaPubHash = ecdsaPubHash;
    }

    toPublicSignals(): string[] {
        return [this.commitment, this.nonce, this.ecdsaPubHash];
    }
}

// Helper functions for Field operations using native BigInt
export class Field {
    private value: bigint;
    public static readonly FIELD_SIZE = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617'); // BN254 field size

    constructor(value: bigint | string | number) {
        if (typeof value === 'string') {
            this.value = BigInt(value);
        } else if (typeof value === 'number') {
            this.value = BigInt(value);
        } else {
            this.value = value;
        }
        // Ensure value is within field
        this.value = this.value % Field.FIELD_SIZE;
        if (this.value < 0n) {
            this.value += Field.FIELD_SIZE;
        }
    }

    toBigInt(): bigint {
        return this.value;
    }

    toString(): string {
        return this.value.toString();
    }

    toHex(): string {
        return '0x' + this.value.toString(16).padStart(64, '0');
    }

    equals(other: Field): boolean {
        return this.value === other.value;
    }

    static fromHex(hex: string): Field {
        if (!hex.startsWith('0x')) {
            throw new Error('Invalid hex prefix');
        }
        return new Field(BigInt(hex));
    }
}

// Import Poseidon from circomlibjs
let poseidonModule: any = null;
let poseidonF: any = null;

async function loadPoseidon() {
    if (!poseidonModule) {
        try {
            // Try to load circomlibjs poseidon
            const buildPoseidon = (await import('circomlibjs')).buildPoseidon;
            const poseidonBuilder = await buildPoseidon();
            poseidonModule = poseidonBuilder;
            poseidonF = poseidonBuilder.F;
        } catch (error) {
            console.warn('Failed to load circomlibjs poseidon, using fallback:', error);
            // Fallback implementation for testing - this is NOT cryptographically secure
            poseidonModule = async (inputs: any[]) => {
                const data = inputs.map(i => i.toString()).join('');
                const encoder = new TextEncoder();
                const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                return BigInt('0x' + hashHex) % Field.FIELD_SIZE;
            };
            poseidonF = {
                toString: (val: any) => val.toString()
            };
        }
    }
    return { poseidon: poseidonModule, F: poseidonF };
}

// Poseidon hash implementation
export class Poseidon {
    static async hash(inputs: Field[]): Promise<Field> {
        const { poseidon, F } = await loadPoseidon();
        const inputBigInts = inputs.map(f => f.toBigInt());
        const hashResult = poseidon(inputBigInts);
        const hashString = F.toString(hashResult);
        return new Field(BigInt(hashString));
    }
}

// Encoding: BigInt to hex string
export function encodeToHex(field: Field): string {
    return field.toHex();
}

// Decoding: Hex string back to Field
export function decodeFromHex(hexStr: string): Field {
    return Field.fromHex(hexStr);
}

// Circuit configuration - buffers only
export interface CircuitBufferConfig {
    wasm: Uint8Array;
    zkey: Uint8Array;
    verificationKey: VerificationKey;
}

// Circuit wrapper for HashKnowledge
export class HashKnowledge {
    private static wasmBuffer?: Uint8Array;
    private static zkeyBuffer?: Uint8Array;
    private static verificationKey?: VerificationKey;

    static setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array, verificationKey: VerificationKey) {
        this.wasmBuffer = wasm;
        this.zkeyBuffer = zkey;
        this.verificationKey = verificationKey;
    }

    static async compile(): Promise<ZkCompiled> {
        if (!this.verificationKey) {
            throw new Error('Circuit not initialized. Call setCircuitBuffers() first.');
        }
        return { verificationKey: this.verificationKey };
    }

    static async prove(secret: Field): Promise<{ proof: SnarkProof; publicSignals: string[] }> {
        if (!this.wasmBuffer || !this.zkeyBuffer) {
            throw new Error('Circuit not initialized. Call setCircuitBuffers() first.');
        }

        // Calculate the hash (this should match what the circuit computes)
        await Poseidon.hash([secret]);

        // Create input for the circuit
        const input = {
            secret: secret.toString()
        };

        // Generate the proof using @zk-kit/groth16
        const { proof, publicSignals } = await groth16Prove(
            input,
            this.wasmBuffer,
            this.zkeyBuffer
        );

        return { proof, publicSignals: publicSignals as string[] };
    }

    static async verify(proof: SnarkProof, publicSignals?: string[]): Promise<boolean> {
        if (!this.verificationKey) {
            throw new Error('Circuit not initialized. Call setCircuitBuffers() first.');
        }

        try {
            // Cast to satisfy @zk-kit/groth16's stricter Groth16Proof type
            // (protocol/curve required there, optional in our shared type).
            const result = await groth16Verify(
                this.verificationKey,
                { proof: proof as unknown as Parameters<typeof groth16Verify>[1]["proof"], publicSignals: (publicSignals || []) as Groth16PublicSignals }
            );
            return result;
        } catch (error) {
            console.error('Verification error:', error);
            return false;
        }
    }
}

// Circuit wrapper for PreimagePoK (Proof of Knowledge)
export class PreimagePoK {
    private static wasmBuffer?: Uint8Array;
    private static zkeyBuffer?: Uint8Array;
    private static verificationKey?: VerificationKey;

    static setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array, verificationKey: VerificationKey) {
        this.wasmBuffer = wasm;
        this.zkeyBuffer = zkey;
        this.verificationKey = verificationKey;
    }

    static async compile(): Promise<ZkCompiled> {
        if (!this.verificationKey) {
            throw new Error('Circuit not initialized. Call setCircuitBuffers() first.');
        }
        return { verificationKey: this.verificationKey };
    }

    static async prove(
        publicInput: AuthPublicInput,
        secret: Field,
        salt: Field,
        ecdsaPub: Field
    ): Promise<{ proof: SnarkProof; publicSignals: string[] }> {
        if (!this.wasmBuffer || !this.zkeyBuffer) {
            throw new Error('Circuit not initialized. Call setCircuitBuffers() first.');
        }

        // Create input for the circuit
        const input = {
            // Public inputs
            commitment: publicInput.commitment,
            nonce: publicInput.nonce,
            ecdsaPubHash: publicInput.ecdsaPubHash,
            // Private inputs
            secret: secret.toString(),
            salt: salt.toString(),
            ecdsaPub: ecdsaPub.toString()
        };

        // Generate the proof using @zk-kit/groth16
        const { proof, publicSignals } = await groth16Prove(
            input,
            this.wasmBuffer,
            this.zkeyBuffer
        );

        return { proof, publicSignals: publicSignals as string[] };
    }

    static async verify(proof: SnarkProof, publicSignals?: string[]): Promise<boolean> {
        if (!this.verificationKey) {
            throw new Error('Circuit not initialized. Call setCircuitBuffers() first.');
        }

        try {
            // Cast to satisfy @zk-kit/groth16's stricter Groth16Proof type
            // (protocol/curve required there, optional in our shared type).
            const result = await groth16Verify(
                this.verificationKey,
                { proof: proof as unknown as Parameters<typeof groth16Verify>[1]["proof"], publicSignals: (publicSignals || []) as Groth16PublicSignals }
            );
            return result;
        } catch (error) {
            console.error('Verification error:', error);
            return false;
        }
    }
}

// Verify function for HashKnowledge proof
export async function verifyHashKnowledge(
    proof: SnarkProof,
    expectedOutput?: Field,
    publicSignals?: string[]
): Promise<boolean> {
    try {
        const result = await HashKnowledge.verify(proof, publicSignals);

        if (!result) {
            console.error('Hash knowledge proof verification failed');
            return false;
        }

        // Optionally verify the public output matches expected value
        if (expectedOutput && publicSignals && publicSignals.length > 0) {
            const outputField = new Field(publicSignals[0]);
            if (!outputField.equals(expectedOutput)) {
                console.error('Public output mismatch in hash knowledge proof');
                return false;
            }
        }

        return true;
    } catch (error) {
        console.error('Error verifying hash knowledge proof:', error);
        return false;
    }
}

// Verify function for PreimagePoK proof
export async function verifyPreimagePoK(
    proof: SnarkProof,
    publicSignals?: string[]
): Promise<boolean> {
    try {
        const result = await PreimagePoK.verify(proof, publicSignals);

        if (!result) {
            console.error('Preimage proof verification failed');
            return false;
        }

        console.log('Preimage proof verified successfully');
        return true;
    } catch (error) {
        console.error('Error verifying preimage proof:', error);
        return false;
    }
}

// Generic verify function that determines which program to use
export async function verify(
    programType: 'HashKnowledge' | 'PreimagePoK',
    proof: SnarkProof,
    options?: {
        expectedOutput?: Field,
        publicSignals?: string[]
    }
): Promise<boolean> {
    if (programType === 'HashKnowledge') {
        return verifyHashKnowledge(proof, options?.expectedOutput, options?.publicSignals);
    } else if (programType === 'PreimagePoK') {
        return verifyPreimagePoK(proof, options?.publicSignals);
    } else {
        throw new Error(`Unknown program type: ${programType}`);
    }
}

// Helper function to verify proof directly
export async function quickVerify(
    program: typeof HashKnowledge | typeof PreimagePoK,
    proof: SnarkProof,
    publicSignals?: string[]
): Promise<boolean> {
    try {
        return await program.verify(proof, publicSignals);
    } catch (error) {
        console.error('Quick verify failed:', error);
        return false;
    }
}

// Function to initialize circuits with buffers
export function initializeCircuits(config: {
    hashKnowledge?: CircuitBufferConfig;
    preimagePoK?: CircuitBufferConfig;
}) {
    if (config.hashKnowledge) {
        HashKnowledge.setCircuitBuffers(
            config.hashKnowledge.wasm,
            config.hashKnowledge.zkey,
            config.hashKnowledge.verificationKey
        );
    }
    if (config.preimagePoK) {
        PreimagePoK.setCircuitBuffers(
            config.preimagePoK.wasm,
            config.preimagePoK.zkey,
            config.preimagePoK.verificationKey
        );
    }
}

// Function to compile and cache verification keys
export async function compilePrograms(): Promise<{
    hashKnowledge: ZkCompiled,
    preimagePoK: ZkCompiled
}> {
    console.log('Compiling ZK circuits...');

    const [hashKnowledgeCompiled, preimagePoKCompiled] = await Promise.all([
        HashKnowledge.compile(),
        PreimagePoK.compile()
    ]);

    console.log('ZK circuits compiled successfully');

    return {
        hashKnowledge: hashKnowledgeCompiled,
        preimagePoK: preimagePoKCompiled
    };
}

export { Field as FieldElement }; // Export with alias to avoid confusion with Field type
