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
    private static events = new Map<string, EventListener | CallableFunction>();

    /**
     * @remarks Listen to an event.
     * @example EventCore.on('event', (e) =\> appLogger.debug(e));
     */
    static on(event: EventCoreEvents, handler: EventListener | CallableFunction) {
        if (!EventCore.events.has(event)) {
            EventCore.events.set(event, handler);
        }
        EventCore.eventTarget.addEventListener(event, handler as EventListener);
    }

    /**
     * @remarks Stop listening to an event.
     * @example EventCore.off('event', handler);
     */
    static off(event: EventCoreEvents, handler: EventListener | CallableFunction) {
        if (EventCore.events.has(event)) {
            EventCore.events.delete(event);
        }
        EventCore.eventTarget.removeEventListener(event, handler as EventListener);
    }

    /**
     * @remarks Emit an event.
     * @example EventCore.emit('event', data);
     */
    static emit(event: EventCoreEvents, data: any) {
        if (!EventCore.events.has(event)) {
            appLogger.debug(`Warning: No listeners for event: ${event}`);
            // appLogger.verbose(`Event data:`, data);
        }
        EventCore.eventTarget.dispatchEvent(new CustomEvent(event, { detail: data }));
    }
}

export default EventCore;