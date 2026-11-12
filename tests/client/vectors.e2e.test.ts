/**
 * Vector search against a DEPLOYED env (staging by default). Needs an app key
 * for an app with a `smoke_docs` collection (text mode, field `category:string`),
 * which plan 3's end-to-end task creates. Skips unless the key is set:
 *
 *   VECTORS_E2E_APP_KEY=… npx vitest --run --project e2e tests/client/vectors.e2e.test.ts
 *
 * Optional: VECTORS_E2E_BASE_URL (default https://api.staging.muhkoo.dev).
 * The key is read from the environment only and never printed.
 */

import { describe, it, expect } from "vitest";
import { Client } from "../../src/core/Client";

const APP_KEY = process.env.VECTORS_E2E_APP_KEY;
const BASE_URL = process.env.VECTORS_E2E_BASE_URL || "https://api.staging.muhkoo.dev";

describe.skipIf(!APP_KEY)("vectors e2e (smoke_docs)", () => {
    it("upsertAndWait by polling, filtered query, delete", async () => {
        const client = new Client({ baseUrl: BASE_URL, apiKey: APP_KEY });
        const docs = client.vectors.collection("smoke_docs");
        const run = Date.now().toString(36);
        const idA = `e2e-${run}-a`;
        const idB = `e2e-${run}-b`;
        try {
            const result = await docs.upsertAndWait(
                [
                    { id: idA, text: `The lighthouse keeper polished the lamp ${run}`, data: { category: "a" } },
                    { id: idB, text: `A recipe for sourdough bread ${run}`, data: { category: "b" } },
                ],
                { timeoutMs: 300_000 },
            );
            expect(result.count).toBe(2);

            const matches = await docs.query({
                text: `lighthouse lamp ${run}`,
                filter: { category: "a" },
            });
            expect(matches.length).toBeGreaterThan(0);
            expect(matches[0].id).toBe(idA);
        } finally {
            await docs.delete([idA, idB]);
        }
    }, 360_000);
});
