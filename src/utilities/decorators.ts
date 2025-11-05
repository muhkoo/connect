/**
 * @public
 * @remarks Waits for a class property to be ready before executing a method, this is a decorator.
 * @param readyPropertyName - The class property to check for readiness
 */
export function RecordToLedger(readyPropertyName: string = "ready"): MethodDecorator | PropertyDecorator {
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
                // appLogger.debug('readyProperty', readyProperty, descriptor, instance);
                appLogger.warn(`Property "${readyPropertyName}" must be a Promise.`);
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