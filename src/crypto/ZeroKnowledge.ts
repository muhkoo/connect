import { groth16 } from 'snarkjs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Type definitions for snarkjs
export interface SnarkProof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
}

export interface PublicSignals {
    [key: string]: string;
}

export interface VerificationKey {
    protocol: string;
    curve: string;
    nPublic: number;
    vk_alpha_1: string[];
    vk_beta_2: string[][];
    vk_gamma_2: string[][];
    vk_delta_2: string[][];
    vk_alphabeta_12: string[][][];
    IC: string[][];
}

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
            poseidonModule = (inputs: any[]) => {
                const hash = crypto.createHash('sha256');
                for (const input of inputs) {
                    hash.update(input.toString());
                }
                const result = hash.digest('hex');
                return BigInt('0x' + result) % Field.FIELD_SIZE;
            };
            poseidonF = {
                toString: (val: any) => val.toString()
            };
        }
    }
    return { poseidon: poseidonModule, F: poseidonF };
}

// Poseidon hash implementation for snarkjs compatibility
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

// Circuit wrapper for HashKnowledge
export class HashKnowledge {
    private static wasmPath?: string;
    private static zkeyPath?: string;
    private static verificationKey?: VerificationKey;

    static setCircuitPaths(wasmPath: string, zkeyPath: string) {
        this.wasmPath = wasmPath;
        this.zkeyPath = zkeyPath;
    }

    static async loadCircuitFiles(): Promise<void> {
        if (!this.wasmPath || !this.zkeyPath) {
            // Try default paths if not set
            const basePath = path.join(process.cwd(), 'circuits', 'build');
            this.wasmPath = path.join(basePath, 'hashKnowledge_js', 'hashKnowledge.wasm');
            this.zkeyPath = path.join(basePath, 'hashKnowledge_0001.zkey');
        }

        // Files will be loaded when needed by snarkjs
    }

    static async compile(): Promise<ZkCompiled> {
        // Load verification key from JSON file if it exists
        const basePath = path.join(process.cwd(), 'circuits', 'build');
        const vkPath = path.join(basePath, 'hashKnowledge_verification_key.json');

        try {
            if (typeof window === 'undefined' && fs.existsSync(vkPath)) {
                // Node.js environment
                const vkData = fs.readFileSync(vkPath, 'utf-8');
                this.verificationKey = JSON.parse(vkData);
            } else {
                // Browser or file doesn't exist - use default
                this.verificationKey = {
                    protocol: 'groth16',
                    curve: 'bn128',
                    nPublic: 1,
                    vk_alpha_1: [],
                    vk_beta_2: [],
                    vk_gamma_2: [],
                    vk_delta_2: [],
                    vk_alphabeta_12: [],
                    IC: []
                };
            }
        } catch (error) {
            console.error('Failed to load verification key:', error);
            // Use default verification key
            this.verificationKey = {
                protocol: 'groth16',
                curve: 'bn128',
                nPublic: 1,
                vk_alpha_1: [],
                vk_beta_2: [],
                vk_gamma_2: [],
                vk_delta_2: [],
                vk_alphabeta_12: [],
                IC: []
            };
        }

        return {
            verificationKey: this.verificationKey!
        };
    }

    static async prove(secret: Field): Promise<{ proof: SnarkProof; publicSignals: string[] }> {
        // Load circuit files if not already loaded
        await this.loadCircuitFiles();

        if (!this.wasmPath || !this.zkeyPath) {
            throw new Error('Circuit paths not set. Call setCircuitPaths or place circuits in default location.');
        }

        // Calculate the hash (this should match what the circuit computes)
        // Note: The hash is computed internally by the circuit
        await Poseidon.hash([secret]);

        // Create input for the circuit
        const input = {
            secret: secret.toString()
        };

        // Generate the proof using snarkjs
        const { proof, publicSignals } = await groth16.fullProve(
            input,
            this.wasmPath,
            this.zkeyPath
        );

        return { proof: proof as SnarkProof, publicSignals };
    }

    static async verify(proof: SnarkProof, publicSignals?: string[]): Promise<boolean> {
        if (!this.verificationKey) {
            throw new Error('Verification key not loaded. Call compile() first.');
        }

        try {
            const result = await groth16.verify(
                this.verificationKey,
                publicSignals || [],
                proof
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
    private static wasmPath?: string;
    private static zkeyPath?: string;
    private static verificationKey?: VerificationKey;

    static setCircuitPaths(wasmPath: string, zkeyPath: string) {
        this.wasmPath = wasmPath;
        this.zkeyPath = zkeyPath;
    }

    static async loadCircuitFiles(): Promise<void> {
        if (!this.wasmPath || !this.zkeyPath) {
            // Try default paths if not set
            const basePath = path.join(process.cwd(), 'circuits', 'build');
            this.wasmPath = path.join(basePath, 'preimagePoK_js', 'preimagePoK.wasm');
            this.zkeyPath = path.join(basePath, 'preimagePoK_0001.zkey');
        }

        // Files will be loaded when needed by snarkjs
    }

    static async compile(): Promise<ZkCompiled> {
        // Load verification key from JSON file if it exists
        const basePath = path.join(process.cwd(), 'circuits', 'build');
        const vkPath = path.join(basePath, 'preimagePoK_verification_key.json');

        try {
            if (typeof window === 'undefined' && fs.existsSync(vkPath)) {
                // Node.js environment
                const vkData = fs.readFileSync(vkPath, 'utf-8');
                this.verificationKey = JSON.parse(vkData);
            } else {
                // Browser or file doesn't exist - use default
                this.verificationKey = {
                    protocol: 'groth16',
                    curve: 'bn128',
                    nPublic: 3, // commitment, nonce, ecdsaPubHash
                    vk_alpha_1: [],
                    vk_beta_2: [],
                    vk_gamma_2: [],
                    vk_delta_2: [],
                    vk_alphabeta_12: [],
                    IC: []
                };
            }
        } catch (error) {
            console.error('Failed to load verification key:', error);
            // Use default verification key
            this.verificationKey = {
                protocol: 'groth16',
                curve: 'bn128',
                nPublic: 3,
                vk_alpha_1: [],
                vk_beta_2: [],
                vk_gamma_2: [],
                vk_delta_2: [],
                vk_alphabeta_12: [],
                IC: []
            };
        }

        return {
            verificationKey: this.verificationKey!
        };
    }

    static async prove(
        publicInput: AuthPublicInput,
        secret: Field,
        salt: Field,
        ecdsaPub: Field
    ): Promise<{ proof: SnarkProof; publicSignals: string[] }> {
        // Load circuit files if not already loaded
        await this.loadCircuitFiles();

        if (!this.wasmPath || !this.zkeyPath) {
            throw new Error('Circuit paths not set. Call setCircuitPaths or place circuits in default location.');
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

        // Generate the proof using snarkjs
        const { proof, publicSignals } = await groth16.fullProve(
            input,
            this.wasmPath,
            this.zkeyPath
        );

        return { proof: proof as SnarkProof, publicSignals };
    }

    static async verify(proof: SnarkProof, publicSignals?: string[]): Promise<boolean> {
        if (!this.verificationKey) {
            throw new Error('Verification key not loaded. Call compile() first.');
        }

        try {
            const result = await groth16.verify(
                this.verificationKey,
                publicSignals || [],
                proof
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

// Function to initialize circuit paths
export function initializeCircuits(config: {
    hashKnowledge?: { wasmPath: string; zkeyPath: string };
    preimagePoK?: { wasmPath: string; zkeyPath: string };
}) {
    if (config.hashKnowledge) {
        HashKnowledge.setCircuitPaths(
            config.hashKnowledge.wasmPath,
            config.hashKnowledge.zkeyPath
        );
    }
    if (config.preimagePoK) {
        PreimagePoK.setCircuitPaths(
            config.preimagePoK.wasmPath,
            config.preimagePoK.zkeyPath
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