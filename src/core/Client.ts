import { assertType, Retry, Ready } from "../utilities";
import { Network, NetworkOptions } from "../network";
import { FileStat, Storage } from "../storage";
import EventCore, { EventCoreEvents } from "../events/EventCore";
import { Message, MessageOptions } from "../messaging";
import { PacketOptions } from "../messaging/Packet";
import semver from 'semver';
import events from "events"


/**
 * Configuration options for initializing an Muhkoo client.
 * @typeParam DBBackend - The type of database backend to use (GRAPHQL or SQL).
 * @typeParam IpfsNode - The IPFS node instance used for network operations.
 * @public
 */
type ClientOptions = {
    apiKey: string; // API key for authentication
    network: NetworkOptions; // Network configuration options
    logLevel?: string; // Optional log level for the client
}

/**
 * Configuration options for sending messages or packets over the network.
 * @public
 */
interface SendOptions extends PacketOptions, MessageOptions { }

function createSymbolKey(config: ClientOptions): string {
    const serialized = JSON.stringify(config, Object.keys(config).sort()) + '_client';
    return serialized;
}

const instances = new Map();


class Client extends EventCore {
    protected _storage: Storage;
    protected _network: Network;
    protected _configs: ClientOptions;
    protected _readyPromise: Promise<boolean>;
    protected _readyResolver!: (value: boolean) => void;
    protected _id!: string;
    protected _timeouts: { [key: string]: any } = {};
    protected _fetchSubscriptions: { [key: string]: CallableFunction } = {};
    readonly version: string = process.env.npm_package_version as string;

    emit = EventCore.emit;
    on = EventCore.on;
    off = EventCore.off;

    /**
     * A promise that resolves to `true` when the client is fully initialized.
     * @public
     */
    ready: Promise<boolean>;

    /**
     * A map storing messages by their IDs.
     * @public
     */
    messages = new Map<string, any>();

    /**
     * An array of interceptor functions to modify packet options before sending.
     * @public
     */
    interceptors: CallableFunction[] = [];


    constructor(options: ClientOptions) {
        if (!options || !options.apiKey) {
            throw new Error("API key is required in Client options");
        }

        if (options && !options.network) {
            throw new Error("Network configuration is required in Client options");
        }

        if (options && options.logLevel) {
            appLogger.setLevel(options.logLevel);
        }
        if (events && typeof events.defaultMaxListeners === 'number')
            events.defaultMaxListeners = 1024;

        if (events && typeof events.setMaxListeners === 'function')
            if (events && typeof events.defaultMaxListeners === 'number')
                events.defaultMaxListeners = 1024;

        if (events && typeof events.setMaxListeners === 'function')
            events.setMaxListeners(1024);
        super();

        const symbolKey = Symbol.for(createSymbolKey(options));

        appLogger.debug(`Client version: ${this.version}`);
        this._network = new Network(options.network);
        this._storage = new Storage({
            network: this._network
        });
        this._configs = options
        this._readyPromise = new Promise((resolve) => {
            this._readyResolver = resolve;
        });
        this.ready = this._readyPromise;
        if (instances.has(symbolKey)) {
            return instances.get(symbolKey);
        }
        this._init();
        instances.set(symbolKey, this);
    }

    /**
     * The unique identifier of the client, set after network initialization.
     * @public
     */
    get id(): string { return this._id; }

    /**
     * The storage interface for reading and writing files.
     * @public
     */
    get storage(): Storage { return this._storage; }

    /**
     * The configuration options used to initialize the client.
     * @public
     */
    get configs(): ClientOptions { return this._configs; }

    // Private initialization method
    private async _init(): Promise<boolean> {
        try {
            this._setupListeners();
            this._readyResolver(true);
            return true;
        } catch (e) {
            appLogger.error(e);
            return false;
        }
    }

    private _evalVersion = (headers: PacketOptions['headers']) => {
        if (!headers) return true;
        let serverVersion = headers['x-muhkoo-version'] as string || '0.0.0';
        if (serverVersion && serverVersion !== this.version) {
            appLogger.verbose(`Version mismatch: ${this.version} vs ${serverVersion}`);
            if (semver.lt(this.version, serverVersion)) {
                appLogger.verbose(`Your version is outdated. Please update to the latest version.`);
            }
            if (semver.gt(this.version, serverVersion)) {
                appLogger.verbose(`Your version is newer than the server. Please check compatibility.`);
            }
            if (headers.length === 0) {
                appLogger.verbose(`No headers found in the packet.`);
            }
            appLogger.verbose(headers)
            return false;
        }
        return true;
    }

    private _emitMessage = (packetOrMessage: PacketOptions | Message) => {
        if (packetOrMessage instanceof Message) {
            this.emit(EventCoreEvents.MESSAGE, packetOrMessage);
        } else {
                this.emit(EventCoreEvents.DATA_RECEIVED, packetOrMessage.message);
        }
    }

    private _addMessageToMemory = (message: Message) => {
        if (this.messages.has(message.id)) {
            appLogger.debug(`Message already exists in memory: ${message.id}`);
            return;
        }
        this.messages.set(message.id, message.id);
        // Keep only the last 500 messages in memory
        if (this.messages.size >= 500) {
            // Clean up old messages if we exceed the limit
            const keys = Array.from(this.messages.keys()).slice(0, -100);
            for (const key of keys) {
                this.messages.delete(key);
            }
        }
    }

    // Sets up network event listeners
    private _setupListeners = () => {
        this._network.subscribe(EventCoreEvents.GET_HISTORY, (event: CustomEvent) => {
            const packet = event.detail;
            if (!packet.message || !packet.headers || !this._evalVersion(packet.headers)) return;
            const body = packet.message.body.payload;
            for (const _msg in body) {
                try {
                    if (body[_msg][1]) {
                        const msg = Message.deserialize(body[_msg][1]);
                        this._addMessageToMemory(msg);
                    }
                } catch (e) {
                    // Silent fail for invalid messages
                }
            }
            if (this._timeouts['newMessages']) clearTimeout(this._timeouts['newMessages']);
            this._timeouts['newMessages'] = setTimeout(() => {
                this.emit(EventCoreEvents.RECEIVED_HISTORY, this.messages);
            }, 100);
        });

    }


    // Processes packet interceptors
    private _processInterceptors = (options?: PacketOptions): PacketOptions => {
        const _default = {
            target: 'server',
            headers: {},
            source: this._id,
            subject: 'general:broadcast'
        } as PacketOptions;
        if (!options && this.interceptors.length === 0) return _default as PacketOptions;
        let _options = _default;
        for (const interceptor of this.interceptors) {
            const _update = interceptor(_options);
            if (_update && _update instanceof Object) {
                _options = _update;
            }
        }
        _options.source = this._id;

        if(options?.target){
            _options.target = options.target;
        }

        if(options?.headers){
            _options.headers = options.headers;
        }

        if (options?.subject) {
            _options.subject = options.subject;
        }
        
        return _options;
    }

    /**
     * Writes a file or stream to the storage system.
     *
     * @param file - The file or readable stream to write.
     * @param fileMeta - Optional metadata for the file (required if `file` is a stream).
     * @returns A readable stream representing the stored data.
     * @throws Error If the file type is invalid, metadata is missing, or the write operation fails.
     * @public
     */
    @Ready() // await this.ready
    @Retry(3)
    public write(file: File): Promise<FileStat> {
        try {
            assertType(file, [File, ReadableStream]);
            let meta: Omit<FileStat, 'id' | 'hash'>;
            
                meta = {
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    lastModified: file.lastModified
                };
            
            return this._storage.write(file, meta);
        } catch (e) {
            appLogger.error(e);
            throw new Error(`Failed to write file`);
        }
    }

    /**
     * Reads a file from storage by its ID.
     *
     * @param fileId - The unique identifier of the file to read.
     * @returns A promise that resolves to the file data as Uint8Array.
     * @throws Error If the file cannot be read or does not exist.
     * @public
     */
    @Ready()
    @Retry(3)
    public read(fileId: string): Promise<Uint8Array> {
        try {
            return this._storage.read(fileId);
        } catch (e) {
            appLogger.error(e);
            throw new Error(`Failed to read file`);
        }
    }

    /**
     * Sends a message over the Muhkoo network.
     *
     * @param message - The message content (string, object, or number).
     * @param _options - Optional settings for the message (e.g., headers, subject, target).
     * @returns A promise resolving to `true` if the send succeeds.
     * @throws Error If the message is empty or invalid.
     * @public
     */
    @Ready()
    public send(message: string | object | number, _options?: {
        headers?: PacketOptions['headers'], // Optional headers for the message
        subject?: string, // The subject of the message, lines up with network layer routing in IPFS
        target?: string, // The target peer or service for the message
        internal?: boolean // Whether the message should be emitted internally (default: true)
    }): Promise<boolean> {
        let internal = true
        if (_options && typeof _options.internal === 'boolean') {
            internal = _options.internal
        }
        if (!message) throw new Error("Message cannot be empty");
        const options = this._processInterceptors(_options as any);
        options.message = new Message(message);
        this._addMessageToMemory(options.message);

        appLogger.debug(`sending message ID:`, options.message.id);
        appLogger.debug(`sending packet:`, {
            headers: options.headers,
            subject: options.subject,
            target: options.target,
            source: options.source,
        });

        appLogger.log(`Client.send:`, internal, options.message.id, options.message.body);
        // This adds internal messaging
        if (internal) {
            this._emitMessage(options);
        }
        return this._network.send(options);
    }
}

export {
    ClientOptions,
    SendOptions,
    Client,
    Message,
    PacketOptions,
    MessageOptions,
    Network,
    Storage,
    EventCore,
    assertType,
    Retry,
    Ready
}

export default Client;