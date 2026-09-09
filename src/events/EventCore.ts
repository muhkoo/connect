export enum EventCoreEvents {
    CONNECTED = "connected",
    DISCONNECTED = "disconnected",
    RECONNECTING = "reconnecting",
    ERROR = "error",
    DATA_RECEIVED = "data_received",
    DATA_SENT = "data_sent",
    MESSAGE = "message",
    GET_HISTORY = "get_history",
    RECEIVED_HISTORY = "received_history",
    // Offline layer — connectivity + background sync lifecycle. Emitted by the
    // ConnectivityManager / SyncEngine; apps subscribe to drive a status UI.
    ONLINE = "online",
    OFFLINE = "offline",
    SYNCING = "syncing",
    SYNC_PROGRESS = "sync_progress",
    SYNC_COMPLETE = "sync_complete",
    SYNC_ERROR = "sync_error",
}


/**
 * @public
 * EventCore is a static event emitter with singleton functionality for global event handling.
 */
export class EventCore {
    private static eventTarget: EventTarget = new EventTarget();
    /**
     * `event -> (caller's handler -> the wrapper actually registered on the
     * EventTarget)`. Two levels because one event can have many listeners and
     * {@link off} must remove exactly the wrapper it registered for that caller.
     */
    private static events = new Map<string, Map<EventListener | CallableFunction, EventListener>>();

    /**
     * @remarks Listen to an event.
     * @example EventCore.on('event', (e) =\> appLogger.debug(e));
     */
    static on(event: EventCoreEvents, handler: EventListener | CallableFunction) {
        let handlers = EventCore.events.get(event);
        if (!handlers) {
            handlers = new Map();
            EventCore.events.set(event, handlers);
        }
        // `addEventListener` ignores a duplicate (type, callback) pair; mirror
        // that here so the bookkeeping can't drift from the EventTarget.
        if (handlers.has(handler)) return;
        // A throwing listener must not take down its siblings or escape to the
        // host: Node's EventTarget surfaces an uncaught listener error as an
        // `uncaughtException`, which terminates the process by default, and
        // browsers fire `window.onerror`. Contain it and keep dispatching.
        const wrapped: EventListener = (e) => {
            try {
                (handler as EventListener)(e);
            } catch (err) {
                appLogger.error(`EventCore: listener for "${event}" threw`, err);
            }
        };
        handlers.set(handler, wrapped);
        EventCore.eventTarget.addEventListener(event, wrapped);
    }

    /**
     * @remarks Stop listening to an event.
     * @example EventCore.off('event', handler);
     */
    static off(event: EventCoreEvents, handler: EventListener | CallableFunction) {
        const handlers = EventCore.events.get(event);
        const wrapped = handlers?.get(handler);
        if (!handlers || !wrapped) return;
        EventCore.eventTarget.removeEventListener(event, wrapped);
        handlers.delete(handler);
        // Drop the event only once its LAST listener is gone, so the
        // "no listeners" warning in `emit` stays truthful.
        if (handlers.size === 0) EventCore.events.delete(event);
    }

    /**
     * @remarks Emit an event.
     * @example EventCore.emit('event', data);
     */
    static emit(event: EventCoreEvents, data: any) {
        if (!EventCore.events.has(event)) {
            appLogger.debug(`Warning: No listeners for event: ${event}`);
        }
        EventCore.eventTarget.dispatchEvent(new CustomEvent(event, { detail: data }));
    }
}

export default EventCore;