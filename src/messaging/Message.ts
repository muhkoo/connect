import { _messageId, generateChecksum, verifyChecksum, serialize, deserialize, _formatBytes, log } from '../utilities';

/**
 * @public
 * @remarks
 * The body type is a generic type that can be any value. Internally we handle the serialization and deserialization of the body.
 */
export type MessageBody = any;

/**
 * @public
 * @remarks
 * The message headers type is a simple record object that contains key value pairs. Think of these as metadata for the message, similar to HTTP headers.
 */
export type MessageHeaders = Map<string, string>;

/**
 * @public
 * @remarks
 * The message options type is a record object that contains the options for the message.
 */
export interface MessageOptions {
    id?: string;
    body: MessageBody;
    status?: "pending" | "processed" | "failed" | "delivered";
    checksum?: string;
}


/**
 * @public
 * @remarks
 * The message class is a simple class that represents a message object.
 * @sealed
 */
export class Message {
    id: string = _messageId();
    timestamp: number = Date.now();
    status?: "pending" | "processed" | "failed" | "delivered" = "pending";
    checksum?: string;
    private _body: MessageBody;

    constructor(msg: MessageBody)
    constructor(msg: MessageOptions)
    constructor(msg: MessageOptions | MessageBody) {

        if (typeof msg === 'object' && msg.hasOwnProperty('body')) {
            this.id = msg.id || this.id;
            this.timestamp = msg.timestamp || this.timestamp;
            this.status = msg.status || this.status;
            this.checksum = msg.checksum || this.checksum;
            this.body = msg.body;
        } else {
            this.body = msg;
        }
        this.validatebodySize();
    }

    get body(): MessageBody {
        return deserialize(this._body);
    }

    set body(value: MessageBody) {
        this._body = serialize(value);
        if (!this.checksum) {
            this.checksum = generateChecksum(this._body);
        }
    }

    verifyChecksum = () => {
        if (!this.checksum) throw new Error("No message checksum");
        const isValid = verifyChecksum(this._body, this.checksum);
        if (!isValid) throw new Error("Invalid message checksum");
    }

    private validatebodySize(maxSize: number = 1024 * 1024 * 3) {
        const sizeInBytes = new TextEncoder().encode(this._body).length;
        if (sizeInBytes > maxSize) {
            throw new Error(`body size exceeds the limit of ${_formatBytes(maxSize)}.`);
        }
    }


    serialize = (): string => {
        return JSON.stringify({
            id: this.id,
            timestamp: this.timestamp,
            body: this.body,
            status: this.status,
            checksum: this.checksum,
        });
    }

    static deserialize = (data: string): Message => {
        if (typeof data !== 'string') {
            log.warn('Message.deserialize: data is not a string', data);
        }
        const msg = JSON.parse(data);
        return new Message(msg);
    }
}

export default Message;