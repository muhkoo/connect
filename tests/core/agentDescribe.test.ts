import { describe, it, expect } from "vitest";
import {
  MuhkooAgent,
  MuhkooSpace,
  MuhkooDB,
  MuhkooFunction,
  ejectAgentPrompt,
  ejectAgentTools,
  getMuhkooAppDescriptor,
} from "../../src/core/agents/describe";

@MuhkooAgent({
  name: "Chat Assistant",
  purpose: "A helpful assistant inside a real-time team chat.",
  guidance: ["Keep replies short.", "Only chime in when relevant."],
  instructions: "Sign off as ~assistant.",
})
class ChatAssistant {
  @MuhkooSpace({ description: "Main team discussion." })
  general!: string;

  @MuhkooSpace({ name: "help-desk", description: "User support triage." })
  support!: string;

  @MuhkooDB({ access: "read", description: "Chat message history." })
  messages!: unknown;

  @MuhkooDB({ table: "tickets", access: "write", description: "Support tickets." })
  ticketTable!: unknown;

  @MuhkooFunction({ description: "Open a support ticket." })
  openTicket!: () => void;
}

@MuhkooAgent({ name: "Bare", purpose: "Nothing wired up." })
class BareAgent {}

class NotDecorated {}

describe("Muhkoo app decorators", () => {
  it("gathers the full surface from the decorated class", () => {
    const d = getMuhkooAppDescriptor(ChatAssistant)!;
    expect(d.agent?.name).toBe("Chat Assistant");
    expect(d.spaces.map((s) => s.name)).toEqual(["general", "help-desk"]);
    expect(d.tables.map((t) => t.table)).toEqual(["messages", "tickets"]);
    expect(d.tables.find((t) => t.table === "tickets")?.access).toBe("write");
    expect(d.functions.map((f) => f.name)).toEqual(["openTicket"]);
  });

  it("ejects a prompt with purpose, guidance, surface, and instructions", () => {
    const prompt = ejectAgentPrompt(ChatAssistant);
    expect(prompt).toContain("You are Chat Assistant.");
    expect(prompt).toContain("A helpful assistant inside a real-time team chat.");
    expect(prompt).toContain("- Keep replies short.");
    expect(prompt).toContain("- general: Main team discussion.");
    expect(prompt).toContain("- help-desk: User support triage.");
    expect(prompt).toContain("messages (read-only");
    expect(prompt).toContain("tickets (read & write");
    expect(prompt).toContain("- openTicket: Open a support ticket.");
    expect(prompt).toContain("Sign off as ~assistant.");
    // Defers exact schema to the runtime roster.
    expect(prompt).toContain("supplied to you by the runtime");
  });

  it("omits empty sections for a bare agent", () => {
    const prompt = ejectAgentPrompt(BareAgent);
    expect(prompt).toContain("You are Bare.");
    expect(prompt).not.toContain("Channels (Spaces)");
    expect(prompt).not.toContain("App database tables");
    expect(prompt).not.toContain("call_function");
  });

  it("derives a tools allowlist matching the described surface", () => {
    const tools = ejectAgentTools(ChatAssistant);
    expect(tools.enabled).toBe(true);
    expect(tools.db.mode).toBe("write"); // at least one writable table
    expect(tools.db.tables).toEqual(["messages", "tickets"]);
    expect(tools.functions).toEqual(["openTicket"]);
    expect(tools.channels).toBe(true);
    expect(tools.maxIterations).toBe(6);

    const bare = ejectAgentTools(BareAgent);
    expect(bare.enabled).toBe(false);
    expect(bare.db.mode).toBe("off");
    expect(bare.channels).toBe(false);
  });

  it("throws when the class isn't decorated with @MuhkooAgent", () => {
    expect(() => ejectAgentPrompt(NotDecorated)).toThrow(/@MuhkooAgent/);
  });
});
