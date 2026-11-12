import { describe, it, expect } from "vitest";
import { AgentsNamespace, type AgentToolsConfig } from "../../src/core/namespaces/AgentsNamespace";
import type { HttpClient } from "../../src/core/HttpClient";

function fakeHttp() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const http = {
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      return { config: {} };
    },
    patch: async (path: string, body: unknown) => {
      calls.push({ method: "PATCH", path, body });
      return { config: {} };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

const tools: AgentToolsConfig = {
  enabled: true,
  db: { mode: "read", tables: ["notes"] },
  functions: [],
  channels: false,
  maxIterations: 3,
  collections: ["docs", "faq"],
};

describe("AgentsNamespace tools.collections", () => {
  it("create sends tools.collections untouched", async () => {
    const { http, calls } = fakeHttp();
    await new AgentsNamespace({ http }).create("app1", { handle: "@a", displayName: "A", systemPrompt: "p", model: "m", tools });
    expect((calls[0].body as { tools: AgentToolsConfig }).tools.collections).toEqual(["docs", "faq"]);
  });

  it("update sends tools.collections untouched", async () => {
    const { http, calls } = fakeHttp();
    await new AgentsNamespace({ http }).update("app1", "ag1", { tools });
    expect(calls[0].method).toBe("PATCH");
    expect((calls[0].body as { tools: AgentToolsConfig }).tools).toEqual(tools);
  });
});
