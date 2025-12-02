// Shim for web-worker in Cloudflare Workers
// Web Workers are not available in CF Workers runtime

class WorkerShim {
    constructor() {
        throw new Error('Web Workers are not supported in Cloudflare Workers');
    }

    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
}

export default WorkerShim;
