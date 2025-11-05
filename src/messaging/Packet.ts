import { Message } from "./Message";
import { _packetId } from "../utilities";

type Address = string;  // Represents a unique peer or node ID in the network

export interface PacketOptions {
    id?: string;
    subject: string;
    source: Address;
    target: Address;
    headers?: {
        [key: string]: string | number | boolean | undefined;  // Optional: Additional headers for the packet
    };
    message?: Message;
    ttl?: number;
    timestamp?: number;
    signature?: string;
}

/**
 * @public
 * @remarks
 * This class represents a message object that can be sent over the network
 * @sealed
 */
export class Packet {
    id: string;
    subject: string;
    source: Address;
    target: Address;
    headers?: PacketOptions['headers'];  // Optional: Additional headers for the packet
    message?: Message; // By making the message optional, we can send packets without messages. Essentially performing a GET request or other bodyless requests
    timestamp: number;
    ttl?: number;  // Optional: Time-to-live in milliseconds
    signature?: string;  // Optional: Cryptographic signature for verification

    constructor({
        id,
        subject,
        source,
        target,
        headers,
        message,
        ttl,
        signature,
        timestamp
    }: PacketOptions) {
        this.id = id || _packetId();  // Ensure the packet has a unique ID
        this.subject = subject;
        this.source = source;
        this.target = target;
        this.headers = headers || {};
        this.message = message;
        this.timestamp = Date.now();  // Automatically track packet creation time
        this.ttl = ttl;
        this.signature = signature;
        this.timestamp = timestamp || Date.now();
    }

    // Serialize the packet for network transmission
    serialize(): string {
        return JSON.stringify({
            id: this.id,
            source: this.source,
            subject: this.subject,
            target: this.target,
            headers: this.headers,
            message: this.message && this.message.serialize(),
            timestamp: this.timestamp,
            ttl: this.ttl,
            signature: this.signature,
        });
    }

    // Deserialize a packet from a string
    static deserialize(data: string): Packet {
        const obj = JSON.parse(data);
        return new Packet({
            id: obj.id,
            subject: obj.subject,
            source: obj.source,
            target: obj.target,
            headers: obj.headers,
            message: obj.message && Message.deserialize(obj.message),
            timestamp: obj.timestamp,
            ttl: obj.ttl,
            signature: obj.signature,
        });
    }

    // Verify TTL: Checks if the packet is still valid based on TTL
    isExpired(): boolean {
        if (!this.ttl) return false;  // No TTL means no expiration
        return Date.now() > this.timestamp + this.ttl;
    }

    // sign(signingKey: string) {
    //     this.signature = generateSignature(this.serialize(), signingKey);  // Example signature function
    // }

    // verifySignature(publicKey: string): boolean {
    //     if (!this.signature) throw new Error("No signature to verify");
    //     return verifySignature(this.serialize(), this.signature, publicKey);
    // }
}