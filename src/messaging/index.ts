// Re-export Message and its types
export { Message, type MessageHeaders, type MessageBody, type MessageOptions } from "./Message";
export { default as MessageDefault } from "./Message";

// Re-export Packet and its types
export { Packet, type PacketOptions } from "./Packet";

// Export decorators
export { SerializeMessage } from "./decorators";

import { SerializeMessage } from "./decorators";
const decorators = {
    SerializeMessage
}

export { decorators }