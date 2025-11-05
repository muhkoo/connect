import { v4 as uuidv4 } from 'uuid';
import log, { Logger } from './Logger';

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export {
    log,
    Logger
}
//0ba25dcb0db07dbac27435857ab55150d2a2e6c8f73a969c74b7659c7a8dd3a3


/**
 * @public
 * @remarks Converts a string to a Uint8Array
 * @param str - The string to convert
 * @returns Uint8Array
 */
export function getSwarmKey(key: string = "n1ce1bfc2a47e208fd668b4d3cbcf7b89ce5cf4c21d489056f11118ae8086836f"): Uint8Array {
    const swarmKeyString = `/key/swarm/psk/1.0.0/\n/base16/\n${key}`;
    const swarmKey = new TextEncoder().encode(swarmKeyString)
    return swarmKey;
}

/**
 * @public
 * @remarks Asserts the basic type of a variable
 * @param value - The value to check
 * @param type - The expected type
 * 
 * @throws Error - If the type of the value does not match the expected type
 * 
 */
export function assertType<T>(
    value: unknown,
    typeOrConstructors: string | (new (...args: any[]) => any) | (new (...args: any[]) => any)[]
): asserts value is T {
    if (typeof typeOrConstructors === 'string') {
        // Single primitive type
        if (typeof value !== typeOrConstructors) {
            throw new Error(
                `Expected type '${typeOrConstructors}', received '${typeof value}'`
            );
        }
    } else if (Array.isArray(typeOrConstructors)) {
        // OR scenario: Array of constructors
        const isValid = typeOrConstructors.some((ctor) => value instanceof ctor);
        if (!isValid) {
            const expectedTypes = typeOrConstructors.map((ctor) => ctor.name).join(' or ');
            const receivedType = value?.constructor?.name || typeof value;
            throw new Error(
                `Expected instance of ${expectedTypes}, received '${receivedType}'`
            );
        }
    } else if (typeof typeOrConstructors === 'function') {
        // Single constructor check
        if (!(value instanceof typeOrConstructors)) {
            const expectedType = typeOrConstructors.name || 'Unknown';
            const receivedType = value?.constructor?.name || typeof value;
            throw new Error(
                `Expected instance of '${expectedType}', received '${receivedType}'`
            );
        }
    } else {
        throw new Error(`Invalid type or constructor provided for assertion.`);
    }
}

/**
 * @public
 * @remarks Encodes a string to Base58
 * @param input - the data to encode, must be a cloneable object
 * @returns string
 */
export function base58Encode(input: ArrayBuffer | string): string {
    const bytes = typeof input === "string"
        ? new TextEncoder().encode(input)
        : new Uint8Array(input);

    let num = BigInt(0);
    for (const byte of bytes) {
        num = (num << BigInt(8)) + BigInt(byte);
    }

    let result = "";
    while (num > 0) {
        const remainder = Number(num % BigInt(58));
        num = num / BigInt(58);
        result = base58Alphabet[remainder] + result;
    }

    // Preserve leading zero bytes as "1" in Base58
    for (const byte of bytes) {
        if (byte === 0) result = "1" + result;
        else break;
    }
    return result;
}


/**
 * @public
 * @remarks Decodes a Base58 string to a Uint8Array
 * @param input - the Base58 string to decode
 * @returns Uint8Array
 */


// Function to decode a Base58 string to ArrayBuffer
export function base58Decode(input: string): ArrayBuffer {
    try {
        const base58Map = new Map(base58Alphabet.split("").map((char, index) => [char, index]));

        let num = BigInt(0);
        for (const char of input) {
            const value = base58Map.get(char);
            if (value === undefined) throw new Error(`Invalid Base58 character: ${char}`);
            num = num * BigInt(58) + BigInt(value);
        }

        const byteArray: number[] = [];
        while (num > 0) {
            byteArray.push(Number(num % BigInt(256)));
            num = num / BigInt(256);
        }

        byteArray.reverse();

        // Restore leading zero bytes from Base58 "1"
        const leadingZeros = Array.from(input).filter((char) => char === "1").length;
        return new Uint8Array([...Array(leadingZeros).fill(0), ...byteArray]).buffer;
    } catch (e) {
        log.error(e);
        throw new Error("Invalid input");
    }
}

/**
 * Simple checksum function using djb2 hash algorithm
 * Works in both browser and Node.js environments
 */
function simpleChecksum(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
    }
    return (hash >>> 0).toString(16); // Convert to unsigned 32-bit hex
}



/**
 * @public
 * @remarks Generates a checksum for a given input
 * @param input - The input to generate a checksum for as a string
 * @returns string
 */
export function generateChecksum(input: string): string {
    assertType<string>(input, "string");
    return simpleChecksum(input);
}

/**
 * @public
 * @remarks Verifies a checksum for a given input
 * @param input - The input to verify as a string
 * @param checksum - The checksum to verify as a string
 * @returns boolean
 */
export function verifyChecksum(input: string, checksum: string): boolean {
    assertType<string>(input, "string");
    assertType<string>(checksum, "string");
    return !!(simpleChecksum(input) === checksum);
}

/**
 * @internal
 * @remarks Generates a random UUID for a given packet
 * @returns string
 */
export function _packetId(): string {
    return "PKT" + generateId();
}

/**
 * @internal
 * @remarks Generates a random UUID for a given object
 * @returns string
 * 
 */

export function _objectId(): string {
    return "OBJ" + generateId();
}

/**
 * @internal
 * @remarks Generates a random UUID for a given user
 * @returns string
 * 
 */

export function _userId(): string {
    return "USR" + generateId();
}

/**
 * @internal
 * @remarks Generates a random UUID for a given account
 * @returns string
 * 
 */

export function _accountId(): string {
    return "ACC" + generateId();
}

/**
 * @internal
 * @remarks Generates a random UUID for a socket
 * @returns string
 * 
 */
export function _socketId(): string {
    return "SKT" + generateId();
}

/**
 * @internal
 * @remarks Generates a random UUID for a message
 * @returns string
 */

export function _messageId(): string {
    return "MSG" + generateId();
}

/**
 * @public
 * @remarks Generates a random UUID and base58 encodes it
 * @returns string
 */

export function generateId(): string {
    return base58Encode(uuidv4());
}

/**
 * @public
 * @remarks Serializes data to a base58 encoded string
 * @param data - The data to serialize
 * @typeParam T - The type of the data to serialize
 * @returns base58 encoded string
 */
export function serialize<T>(data: T): string {
    const arrayBuffer = structuredCloneToArrayBuffer(data);
    return base58Encode(arrayBuffer);
}

/**
 * @public
 * @remarks Deserializes a base58 encoded string to data
 * @param base58String - The base58 encoded string to deserialize
 * @returns Deserialized data
 */
export function deserialize<T>(base58String: string): T {
    const arrayBuffer = base58Decode(base58String);
    return deserializeWithStructuredClone(arrayBufferToData(arrayBuffer)) as T;
}

function deserializeWithStructuredClone(data: any): unknown {
    const deserializeHelper = (item: any): any => {
        if (item === null || typeof item !== 'object') {
            return item; // Handle primitives directly
        }

        if (item.__type === "Symbol") {
            return Symbol.for(item.value) || Symbol(item.value);
        }

        if (item.__type === 'Date') {
            return new Date(item.value); // Rehydrate Date
        }

        if (item.__type === 'Map') {
            return new Map(item.value); // Rehydrate Map
        }

        if (item.__type === 'Set') {
            return new Set(item.value); // Rehydrate Set
        }

        if (Array.isArray(item)) {
            return item.map(deserializeHelper); // Rehydrate Array recursively
        }

        // Generic object case
        const deserializedObject: any = {};
        for (const key of Object.keys(item)) {
            deserializedObject[key] = deserializeHelper(item[key]);
        }
        return deserializedObject;
    };

    return deserializeHelper(data);
}

function structuredCloneToArrayBuffer(data: any): ArrayBuffer {
    // Clone and transform the data for serialization
    const serializeHelper = (item: any): any => {
        if (item === null || typeof item !== "object") return item;

        if (typeof item === "symbol") {
            const key = Symbol.keyFor(item) || item.description || "";
            return { __type: "Symbol", value: key };
        }

        if (item.constructor === Date) return { __type: "Date", value: item.toISOString() };
        if (item.constructor === Map) return { __type: "Map", value: Array.from(item.entries()) };
        if (item.constructor === Set) return { __type: "Set", value: Array.from(item) };
        if (Array.isArray(item)) return item.map(serializeHelper);

        const serializedObject: any = {};
        for (const key of Object.keys(item)) {
            serializedObject[key] = serializeHelper(item[key]);
        }
        return serializedObject;
    };

    // Serialize the structured data into a JSON string
    const jsonString = JSON.stringify(serializeHelper(data));
    return new TextEncoder().encode(jsonString).buffer as ArrayBuffer;
}

function arrayBufferToData(arrayBuffer: ArrayBuffer): any {
    let jsonString = new TextDecoder().decode(new Uint8Array(arrayBuffer));
    jsonString = jsonString.replace(/^\0+/, '')
    return JSON.parse(jsonString);
}

/**
 * @public
 * @remarks Retries a method a specified number of times with a delay between each attempt, this is a decorator
 * @param retries - The number of times to retry the method
 * @param delay - The delay in milliseconds between each attempt
 */
export function Retry(retries: number = 3, delay: number = 1000): MethodDecorator {

    return function (target: object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<any>) {
        // Ensure the descriptor exists
        if (!descriptor || typeof descriptor.value !== "function") {
            throw new Error("Retry decorator can only be applied to methods.");
        }

        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            let attempt = 0;

            while (attempt < retries) {
                try {
                    return await originalMethod.apply(this, args);
                } catch (error) {
                    attempt++;
                    log.debug(`Retrying ${String(propertyKey)} - Attempt ${attempt}/${retries}`);
                    if (attempt >= retries) {
                        throw error; // Re-throw the error if retries are exhausted
                    }
                    log.log(`Waiting for ${delay}ms before retrying...`);
                    await new Promise(res => setTimeout(res, delay));
                }
            }
        };

        return descriptor;
    };
}

/**
 * @public
 * @remarks Waits for a class property to be ready before executing a method, this is a decorator.
 * @param readyPropertyName - The class property to check for readiness
 */
export function Ready(readyPropertyName: string = "ready"): MethodDecorator | PropertyDecorator {
    return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        if (descriptor === undefined) {
            throw new Error("@Ready can only be applied to methods, getters, or setters.");
        }

        const isGetter = typeof descriptor.get === "function";
        const isSetter = typeof descriptor.set === "function";
        const isMethod = typeof descriptor.value === "function";

        const readyCheck = async (instance: any) => {
            const readyProperty = instance[readyPropertyName];

            if (!readyProperty || !(readyProperty instanceof Promise)) {
                log.warn(`Property "${readyPropertyName}" must be a Promise.`);
                return
            }
            await readyProperty; // Wait for the property to resolve
        };

        if (isMethod) {
            const originalMethod = descriptor.value;
            descriptor.value = async function (...args: any[]) {
                await readyCheck(this);
                return originalMethod.apply(this, args);
            };
        } else if (isGetter || isSetter) {
            const originalGetter = descriptor.get;
            const originalSetter = descriptor.set;

            if (isGetter) {
                descriptor.get = async function () {
                    await readyCheck(this);
                    return originalGetter!.call(this);
                };
            }

            if (isSetter) {
                descriptor.set = async function (value: any) {
                    await readyCheck(this);
                    return originalSetter!.call(this, value);
                };
            }
        } else {
            throw new Error("@Ready can only be applied to methods, getters, or setters.");
        }

        return descriptor;
    };
}


/**
 * Converts bytes into a more human-friendly format (e.g., KB, MB, GB).
 * @internal
 * @param bytes - The number of bytes to convert.
 * @param decimals - The number of decimals to display (default is 2).
 * @returns A formatted string representing the size in appropriate units.
 */
export function _formatBytes(bytes: number, decimals: number = 2): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024; // 1 KB = 1024 Bytes
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k)); // Determines the index for size
    const sizeInUnit = bytes / Math.pow(k, i); // Converts bytes to appropriate unit

    return `${sizeInUnit.toFixed(decimals)} ${sizes[i]}`;
}

/**
 * Retrieves the IP address(es) for a given hostname using Cloudflare's DNS-over-HTTPS service.
 *
 * This function queries the Cloudflare DNS API to resolve the provided hostname to its corresponding
 * IPv4 address(es) (A records). It returns an array of IP addresses or logs an error if the resolution fails.
 *
 * @param hostname - The hostname to resolve (e.g., "example.com").
 * @returns A promise that resolves to an array of IP addresses (strings) associated with the hostname.
 *          If no IP addresses are found or an error occurs, an empty array or undefined may be returned.
 * @throws Error If the DNS query fails due to a network error or invalid response from the server.
 * @public
 * @example
 * ```typescript
 * import { log } from '@muhkoo/connect/utilities';
 * getIPAddress("example.com").then(ips => log.debug(ips));
 * // Output: ["93.184.216.34"]
 * ```
 */
export async function getIPAddress(hostname: string) {
    const url = `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`;

    try {
        const response = await fetch(url, {
            headers: {
                Accept: "application/dns-json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch DNS records: ${response.statusText}`);
        }

        const data = await response.json();

        // Extract the IP address from the DNS response
        const ipAddresses = data.Answer?.map((record: { data: string }) => record.data) || [];
        log.debug(`IP addresses for ${hostname}:`, ipAddresses);

        return ipAddresses;
    } catch (error) {
        log.error(`Error resolving IP for ${hostname}:`, error);
    }
}

export function isNumber(value: string | number): boolean {
    // Check if the value is a number
    if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
        return true;
    }
    // Check if the value is a string and represents a valid number
    if (typeof value === 'string') {
        return !isNaN(parseFloat(value)) && isFinite(value as any);
    }
    // Return false for other types
    return false;
}

export function getId(row: {insertId?: number, id?: number}): number {
    if (row.insertId) {
        return row.insertId;
    } else if (row.id) {
        return row.id;
    } else {
        throw new Error('No ID found in the row');
    }
}