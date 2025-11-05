import Client from "./Client";
import { Logger } from "../utilities/Logger";

declare global {
    var appLogger: InstanceType<typeof Logger>;
}

const appLogger = new Logger("connect", 'ERROR');
globalThis.appLogger = appLogger;

export {
    appLogger,
    Logger,
    Client
};
