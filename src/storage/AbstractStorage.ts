import { EventCore } from "../events/EventCore";


/**
 * @public
 * AbstractStorage is an abstract class that provides a blueprint for storage implementations.
 * It defines methods for reading, writing, and deleting data, as well as chunking files.
 * @internal
 * @remarks
 * This class is not intended to be used directly. Instead, it should be extended by concrete storage implementations.
 */
export class AbstractStorage extends EventCore {

    constructor() {
        super();
    }

    /**
     * @remarks
     * This method should be implemented by subclasses to read data from storage.
     * @param obj - The object identifier or key to read data from.
     * @returns A promise that resolves to the data read from storage.
     */
    async read(obj: string): Promise<ArrayBufferLike> {
        throw new Error("Method not implemented.");
    }

    /**
     * @remarks
     * This method should be implemented by subclasses to write data to storage.
     * @param file - The file or data to write to storage.
     * @returns A promise that resolves to the identifier or key of the written data.
     */
    async write(file: File): Promise<string> {
        throw new Error("Method not implemented.");
    }

    /**
     * @remarks
     * This method should be implemented by subclasses to delete data from storage.
     * @param key - The identifier or key of the data to delete.
     * @returns A promise that resolves to a boolean indicating success or failure.
     */
    async delete(key: string): Promise<boolean> {
        throw new Error("Method not implemented.");
    }

    /**
     * @remarks
     * This method should be implemented by subclasses to get the size of data in storage.
     * @param key - The identifier or key of the data.
     * @returns A promise that resolves to the size of the data in bytes.
     */
    private chunker(chunkSize: number): TransformStream<Uint8Array, Uint8Array> {
        let buffer = new Uint8Array(0);

        return new TransformStream({
            transform(chunk, controller) {
                // Combine the existing buffer with the new chunk
                const combined = new Uint8Array(buffer.length + chunk.length);
                combined.set(buffer);
                combined.set(chunk, buffer.length);
                buffer = combined;

                // While there is enough data, output full chunks
                while (buffer.length >= chunkSize) {
                    controller.enqueue(buffer.slice(0, chunkSize));
                    buffer = buffer.slice(chunkSize);
                }
            },
            flush(controller) {
                // Enqueue any remaining data (smaller than chunkSize)
                if (buffer.length > 0) {
                    controller.enqueue(buffer);
                }
            }
        });
    }

    /**
     * @remarks
     * This method should be implemented by subclasses to get the size of data in storage.
     * @param key - The identifier or key of the data.
     * @returns A promise that resolves to the size of the data in bytes.
     */
    protected chunkFile(file: File, chunkSize: number = 2 * 1024 * 1024): Blob[] {
        const chunks = [];
        const fileSize = file.size;
        let offset = 0;

        while (offset < fileSize) {
            const chunk = file.slice(offset, offset + chunkSize);
            chunks.push(chunk);
            offset += chunkSize;
        }

        return chunks;
    }

    /**
     * @remarks
     * This method should be implemented by subclasses to assemble the file from chunks.
     * @param chunks - An array of Blob objects representing the file chunks.
     * @returns A Blob object representing the assembled file.
     */
    protected assembleFile(chunks: Blob[]): Blob {
        return new Blob(chunks);
    }
}

export default AbstractStorage;