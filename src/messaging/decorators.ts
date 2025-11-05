import { Message } from "./Message";
import { Packet } from "./Packet";


export function SerializeMessage(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
        const [subject, message] = args;

        if (typeof message !== "string") {
            throw new Error("Message must be a string");
        }

        const serializedMessage = new Message({
            subject,
            payload: message,
            status: "pending",
            headers: new Map([["Content-Type", "application/json"]]),
        }).serialize();


        return originalMethod.apply(this, [subject, serializedMessage]);
    };

    return descriptor;
}