/**
 * `HttpError` — thrown for any non-2xx accelerator response.
 *
 * In a module of its own so that `PaymentRequiredError` can extend it while
 * `HttpClient`, which throws both, imports `PaymentRequiredError`: with the
 * class in `HttpClient.ts`, the two modules would import each other, and
 * whichever loaded second would extend a class not yet defined. `HttpClient`
 * re-exports it, so `import { HttpError } from "./HttpClient"` still works.
 */

/** Thrown for any non-2xx accelerator response. Carries the HTTP status. */
export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message);
        this.name = "HttpError";
    }
}
