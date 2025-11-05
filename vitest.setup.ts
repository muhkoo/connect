import {Logger} from "./src/utilities/Logger";


// Patch global if not already defined
if (!globalThis.appLogger) {
    globalThis.appLogger = new Logger("connect-test", "DEBUG"); // or whatever level you want for tests
}

// Polyfill crypto for Node.js if needed
if (typeof globalThis.crypto === 'undefined') {
  const { webcrypto } = await import('crypto');
  // @ts-ignore
  globalThis.crypto = webcrypto;
}


declare global {
    var appLogger: Logger;
}

export { };