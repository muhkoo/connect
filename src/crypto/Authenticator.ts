import { PreimagePoK, AuthPublicInput } from './ZeroKnowledge';
import { subtle } from 'crypto';
import { verify, Field, Poseidon } from 'o1js';

interface AuthToken {
  peerId: string;
  timestamp: number;
  signature: string;
}

class Authenticator {
    private trustedKeys: Map<string, CryptoKey> = new Map();
    private zkVerificationKey: { data: string; hash: Field } | null = null;

    public async initializeZK(): Promise<void> {
        if (!this.zkVerificationKey) {
            appLogger.debug('Compiling PreimagePoK for verification...');
            const compiled = await PreimagePoK.compile();
            this.zkVerificationKey = compiled.verificationKey;
        }
    }

    public getZKVerificationKey(): { data: string; hash: Field } | null {
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
        return { peerId, timestamp, signature: Buffer.from(signature).toString('hex') };
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
            Buffer.from(token.signature, 'hex'),
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
        const isValid = await verify(proof.toJSON(), this.zkVerificationKey);
        if (!isValid) {
            appLogger.debug('ZK proof verification failed');
            return false;
        }
        const matchesCommitment = proof.publicInput.commitment.equals(storedCommitment).toBoolean();
        const matchesNonce = proof.publicInput.nonce.equals(publicInput.nonce).toBoolean();
        const ecdsaJwk = await crypto.subtle.exportKey('jwk', ecdsaPub);
        const ecdsaHex = Buffer.from(ecdsaJwk.x!, 'base64url').toString('hex').slice(0, 64);
        const ecdsaPubField = Field(BigInt('0x' + ecdsaHex));
        const matchesEcdsaPub = proof.publicInput.ecdsaPubHash.equals(Poseidon.hash([ecdsaPubField])).toBoolean();

        appLogger.debug('ZK proof valid:', isValid, 'Commitment:', matchesCommitment, 'Nonce:', matchesNonce, 'ECDSA:', matchesEcdsaPub);
        return isValid && matchesCommitment && matchesNonce && matchesEcdsaPub;
    }
}

export { Authenticator, AuthToken };