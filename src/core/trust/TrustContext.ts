import type { HttpClient } from "../HttpClient";
import type { SessionState } from "../Session";
import { IdentityDirectory } from "./IdentityDirectory";
import { SeedIdentitySigner, type IdentitySigner } from "./IdentitySigner";
import { PinStore, spacePinKey } from "./PinStore";
import { openTrustStore, type TrustStore } from "./trustStore";

/** One per Client: shared by every Space (and, in sub-project 4, DMs). */
export class TrustContext {
    readonly directory: IdentityDirectory;
    readonly signer: IdentitySigner;
    readonly pins: PinStore;
    private storeP: Promise<TrustStore> | null = null;
    private opened: TrustStore | null = null;
    private appIdP: Promise<string> | null = null;

    constructor(private readonly deps: { http: HttpClient; session: SessionState; openStore?: () => Promise<TrustStore> }) {
        this.directory = new IdentityDirectory(deps.http);
        this.signer = new SeedIdentitySigner({ session: deps.session, directory: this.directory });
        this.pins = new PinStore({
            http: deps.http,
            commitment: () => deps.session.commitment,
            signer: this.signer,
            store: () => this.store(),
        });
        // Start opening muhkoo.trust now, so `persistent` has settled by the time an app asks (KI1).
        // A failed open reaches whoever awaits store(); it is not an unhandled rejection here.
        this.store().catch(() => undefined);
    }

    /** Whether muhkoo.trust survives a restart (KI1): false until the open settles, and false for an in-memory store. */
    get persistent(): boolean {
        return this.opened?.persistent ?? false;
    }

    store(): Promise<TrustStore> {
        return (this.storeP ??= (this.deps.openStore ?? openTrustStore)().then((s) => (this.opened = s)));
    }

    /** This app's id, from GET /api/app/trust (a genesis must name it, D4). Cached; a failure is retried next call. */
    appId(): Promise<string> {
        return (this.appIdP ??= this.deps.http
            .get<{ appId?: string }>("/api/app/trust")
            .then((r) => {
                if (!r?.appId) throw new Error("app trust: no appId");
                return r.appId;
            })
            .catch((e) => {
                this.appIdP = null;
                throw e;
            }));
    }

    /** User-confirmed "Reset trust for this space" (design §9.1): drop its genesis pin and log high-water. */
    async resetSpacePins(spaceId: string): Promise<void> {
        await this.pins.unpin("spaces", [await spacePinKey(spaceId)]);
        await (await this.store()).del(`loghw:${this.deps.session.commitment}:${spaceId}`);
    }

    /** `client.trust.unpin(username)`: forget a member's pinned identity after comparing safety numbers (design §3.4). */
    async unpinUser(username: string): Promise<void> {
        await this.pins.unpin("identity", [username.toLowerCase()]);
    }
}
