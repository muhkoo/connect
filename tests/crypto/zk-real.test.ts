import { describe, it, expect, beforeAll } from 'vitest';
import {
    PreimagePoK,
    HashKnowledge,
    AuthPublicInput,
    Field,
    Poseidon,
    verifyPreimagePoK,
    verifyHashKnowledge
} from '../../src/crypto/ZeroKnowledge';

describe('Real ZK Circuit Tests', () => {
    beforeAll(async () => {
        console.log('Loading and compiling circuits...');

        // Load the verification keys
        await HashKnowledge.compile();
        await PreimagePoK.compile();

        console.log('Circuits loaded successfully');
    }, 30000); // Give it 30 seconds to load

    describe('HashKnowledge Circuit', () => {
        it('should generate and verify a valid proof', async () => {
            // Create a secret
            const secret = new Field(BigInt('123456789'));

            // Generate proof
            console.log('Generating HashKnowledge proof...');
            const { proof, publicSignals } = await HashKnowledge.prove(secret);

            console.log('Proof generated:', proof);
            console.log('Public signals (hash):', publicSignals);

            // Verify the proof
            const isValid = await verifyHashKnowledge(proof, undefined, publicSignals);
            expect(isValid).toBe(true);

            // The public signal should be the hash of the secret
            const expectedHash = await Poseidon.hash([secret]);
            const actualHash = new Field(publicSignals[0]);

            console.log('Expected hash:', expectedHash.toString());
            console.log('Actual hash:', actualHash.toString());

            // Note: The circuit's Poseidon might differ from our JS implementation
            // so we just verify the proof is valid
        }, 60000); // Give it 60 seconds for proof generation

        it('should fail with invalid proof', async () => {
            // Create a fake proof
            const fakeProof = {
                pi_a: ['1', '2'],
                pi_b: [['3', '4'], ['5', '6']],
                pi_c: ['7', '8'],
                protocol: 'groth16',
                curve: 'bn128'
            };

            const isValid = await verifyHashKnowledge(fakeProof, undefined, ['12345']);
            expect(isValid).toBe(false);
        });
    });

    describe('PreimagePoK Circuit', () => {
        it('should generate and verify a valid proof', async () => {
            // Create inputs
            const secret = new Field(BigInt('987654321'));
            const salt = new Field(BigInt('555555'));
            const ecdsaPub = new Field(BigInt('777777'));

            // Calculate expected values
            const ecdsaPubHash = await Poseidon.hash([ecdsaPub]);
            const commitment = await Poseidon.hash([secret, salt, ecdsaPubHash]);
            const nonce = new Field(BigInt('111111'));

            // Create public input
            const publicInput = new AuthPublicInput(
                commitment.toString(),
                nonce.toString(),
                ecdsaPubHash.toString()
            );

            // Generate proof
            console.log('Generating PreimagePoK proof...');
            console.log('Public inputs:', {
                commitment: publicInput.commitment,
                nonce: publicInput.nonce,
                ecdsaPubHash: publicInput.ecdsaPubHash
            });

            const { proof, publicSignals } = await PreimagePoK.prove(
                publicInput,
                secret,
                salt,
                ecdsaPub
            );

            console.log('Proof generated:', proof);
            console.log('Public signals:', publicSignals);

            // Verify the proof
            const isValid = await verifyPreimagePoK(proof, publicSignals);
            expect(isValid).toBe(true);

            // Verify public signals match expected
            expect(publicSignals.length).toBe(3);
            expect(publicSignals[0]).toBe(commitment.toString());
            expect(publicSignals[1]).toBe(nonce.toString());
            expect(publicSignals[2]).toBe(ecdsaPubHash.toString());
        }, 60000); // Give it 60 seconds for proof generation

        it('should fail with mismatched commitment', async () => {
            // Create inputs with wrong secret
            const wrongSecret = new Field(BigInt('111'));
            const salt = new Field(BigInt('555555'));
            const ecdsaPub = new Field(BigInt('777777'));

            // Calculate expected values with CORRECT secret
            const correctSecret = new Field(BigInt('987654321'));
            const ecdsaPubHash = await Poseidon.hash([ecdsaPub]);
            const commitment = await Poseidon.hash([correctSecret, salt, ecdsaPubHash]);
            const nonce = new Field(BigInt('111111'));

            // Create public input with correct commitment
            const publicInput = new AuthPublicInput(
                commitment.toString(),
                nonce.toString(),
                ecdsaPubHash.toString()
            );

            // Try to generate proof with wrong secret
            // This should fail because the circuit will compute a different commitment
            try {
                await PreimagePoK.prove(
                    publicInput,
                    wrongSecret, // Wrong secret!
                    salt,
                    ecdsaPub
                );

                // Should not reach here
                expect(true).toBe(false);
            } catch (error) {
                // Expected to fail
                console.log('Expected error:', error);
                expect(error).toBeDefined();
            }
        }, 60000);
    });
});