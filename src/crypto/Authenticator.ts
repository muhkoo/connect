import { PreimagePoK, AuthPublicInput, Field, Poseidon, verify, VerificationKey } from './ZeroKnowledge';
import { toHex, fromHex, fromBase64Url } from '../utilities';

interface AuthToken {
    peerId: string;
    timestamp: number;
    signature: string;
}

class Authenticator {
    private trustedKeys: Map<string, CryptoKey> = new Map();
    private zkVerificationKey: VerificationKey | null = null;

    public async initializeZK(): Promise<void> {
        if (!this.zkVerificationKey) {
            appLogger.debug('Compiling PreimagePoK for verification...');
            const compiled = await PreimagePoK.compile();
            this.zkVerificationKey = compiled.verificationKey;
        }
    }

    public getZKVerificationKey(): VerificationKey | null {
        return this.zkVerificationKey;
    }

    public addTrustedServer(serverId: string, publicKey: CryptoKey): void {
        this.trustedKeys.set(serverId, publicKey);
    }

    public async generateAuthToken(peerId: string, privateKey: CryptoKey): Promise<AuthToken> {
        if (!privateKey) {
            throw new Error(`No private key for ${peerId}`);
        }
        const timestamp = Date.now();
        const data = new TextEncoder().encode(`${peerId}:${timestamp}`);
        const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            privateKey,
            data
        );
        return { peerId, timestamp, signature: toHex(new Uint8Array(signature)) };
    }

    public async verifyAuthToken(token: AuthToken, clientPublicKey: CryptoKey): Promise<boolean> {
        const maxAge = 5 * 60 * 1000;
        if (Math.abs(Date.now() - token.timestamp) > maxAge) {
            appLogger.debug('Auth token expired');
            return false;
        }
        return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            clientPublicKey,
            fromHex(token.signature),
            new TextEncoder().encode(`${token.peerId}:${token.timestamp}`)
        );
    }

    public async verifyZKProof(
        proof: any,
        publicInput: AuthPublicInput,
        storedCommitment: Field,
        ecdsaPub: CryptoKey
    ): Promise<boolean> {
        if (!this.zkVerificationKey) {
            throw new Error('ZK verification key not initialized');
        }

        // Convert publicInput to signals array for snarkjs
        const publicSignals = publicInput.toPublicSignals();

        // Verify the proof using snarkjs
        const isValid = await verify('PreimagePoK', proof, { publicSignals });
        if (!isValid) {
            appLogger.debug('ZK proof verification failed');
            return false;
        }

        // Verify the commitment matches stored value
        const proofCommitment = new Field(publicSignals[0]);
        const matchesCommitment = proofCommitment.equals(storedCommitment);

        // Verify nonce matches
        const proofNonce = new Field(publicSignals[1]);
        const expectedNonce = new Field(publicInput.nonce);
        const matchesNonce = proofNonce.equals(expectedNonce);

        // Verify ECDSA public key hash
        const ecdsaJwk = await crypto.subtle.exportKey('jwk', ecdsaPub);
        const ecdsaHex = toHex(fromBase64Url(ecdsaJwk.x!)).slice(0, 64);
        const ecdsaPubField = new Field(BigInt('0x' + ecdsaHex));
        const expectedEcdsaPubHash = await Poseidon.hash([ecdsaPubField]);
        const proofEcdsaPubHash = new Field(publicSignals[2]);
        const matchesEcdsaPub = proofEcdsaPubHash.equals(expectedEcdsaPubHash);

        appLogger.debug('ZK proof valid:', isValid, 'Commitment:', matchesCommitment, 'Nonce:', matchesNonce, 'ECDSA:', matchesEcdsaPub);
        return isValid && matchesCommitment && matchesNonce && matchesEcdsaPub;
    }
}

export { Authenticator, AuthToken };