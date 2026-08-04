/**
 * Muhkoo app decorators — declare your app's agent-facing surface in code, then
 * "eject" a system prompt you hand to a Programmable Agent.
 *
 * You annotate a plain class with `@MuhkooAgent` (the app's identity + how the
 * agent should behave) plus per-surface decorators — `@MuhkooSpace`,
 * `@MuhkooDB`, `@MuhkooFunction` — that describe what each channel, table, and
 * function is *for*. {@link ejectAgentPrompt} reads those annotations and
 * produces a `systemPrompt` string:
 *
 * ```ts
 * @MuhkooAgent({
 *   name: "Chat Assistant",
 *   purpose: "A helpful assistant inside a real-time team chat.",
 *   guidance: ["Keep replies short.", "Only chime in when relevant."],
 * })
 * class ChatAssistant {
 *   @MuhkooSpace({ description: "Main team discussion." })            general!: string;
 *   @MuhkooDB({ access: "read", description: "Chat message history." }) messages!: unknown;
 *   @MuhkooFunction({ description: "Open a support ticket." })         openTicket!: () => void;
 * }
 *
 * const systemPrompt = ejectAgentPrompt(ChatAssistant);
 * await client.agents.create({ handle: "assistant", displayName: "Assistant", systemPrompt });
 * ```
 *
 * The ejected prompt owns the **semantic** layer — what the app is, how to act,
 * and what each surface means. The Muhkoo runtime separately appends the
 * **authoritative** roster (exact columns, function parameters, and the closed
 * list of callable tools), so the prompt here never needs to restate schema and
 * can't drift from it. Decorators only describe; they never change runtime
 * behavior, so they're safe to apply to a throwaway descriptor class.
 *
 * Requires `experimentalDecorators` (already enabled in this package). Metadata
 * is captured in a per-class registry — no `reflect-metadata` dependency.
 */

import type { AgentToolsConfig } from "../namespaces/AgentsNamespace";

/** Whether the agent may only read a table, or read and write it. */
export type MuhkooDBAccess = "read" | "write";

/** App-level identity + behavioral guidance — the heart of the ejected prompt. */
export interface MuhkooAgentMeta {
  /** The agent persona's name (e.g. "Chat Assistant"). */
  name: string;
  /** What the app is and the agent's role in it. One or two sentences. */
  purpose: string;
  /** Short behavioral rules, rendered as a bulleted list. */
  guidance?: string[];
  /** Optional free-form instructions appended verbatim after the surface. */
  instructions?: string;
}

/** A channel/Space the agent can resolve and post into. */
export interface MuhkooSpaceMeta {
  /** Channel name. Defaults to the decorated member's name. */
  name?: string;
  description: string;
}

/** An app database table the agent can query (and optionally mutate). */
export interface MuhkooDBMeta {
  /** Table name. Defaults to the decorated member's name. */
  table?: string;
  /** Read-only by default. */
  access?: MuhkooDBAccess;
  /**
   * Backend-only table — omitted from {@link ejectAgentPrompt}. Use for tables
   * an agent should never be told about (server-managed / internal state).
   */
  backend?: boolean;
  description: string;
}

/** A serverless function the agent can invoke via `call_function`. */
export interface MuhkooFunctionMeta {
  /** Function name. Defaults to the decorated member's name. */
  name?: string;
  description: string;
}

interface SpaceEntry { name: string; description: string; }
interface TableEntry { table: string; access: MuhkooDBAccess; description: string; backend: boolean; }
interface FunctionEntry { name: string; description: string; }

/** The full annotated surface gathered from one decorated class. */
export interface MuhkooAppDescriptor {
  agent?: MuhkooAgentMeta;
  spaces: SpaceEntry[];
  tables: TableEntry[];
  functions: FunctionEntry[];
}

// Per-class metadata store, keyed by the class constructor. Member decorators
// run during class-body evaluation (before the class decorator), so each
// decorator get-or-creates the descriptor and they all converge on one entry.
const REGISTRY = new WeakMap<object, MuhkooAppDescriptor>();

function descriptorFor(ctor: object): MuhkooAppDescriptor {
  let d = REGISTRY.get(ctor);
  if (!d) {
    d = { spaces: [], tables: [], functions: [] };
    REGISTRY.set(ctor, d);
  }
  return d;
}

/** Resolve the owning class constructor from a decorator `target` — the
 *  prototype for instance members, the constructor itself for static ones. */
function ctorOf(target: object): object {
  return typeof target === "function" ? target : (target as { constructor: object }).constructor;
}

/**
 * Class decorator. Declares the app's agent identity, purpose, and behavioral
 * guidance. Apply it to the class whose members carry the surface decorators.
 */
export function MuhkooAgent(meta: MuhkooAgentMeta): ClassDecorator {
  return (target) => {
    descriptorFor(target as unknown as object).agent = meta;
  };
}

/** Member decorator. Marks a channel/Space the agent can resolve and post to. */
export function MuhkooSpace(meta: MuhkooSpaceMeta): PropertyDecorator & MethodDecorator {
  return ((target: object, propertyKey: string | symbol) => {
    descriptorFor(ctorOf(target)).spaces.push({
      name: meta.name ?? String(propertyKey),
      description: meta.description,
    });
  }) as PropertyDecorator & MethodDecorator;
}

/** Member decorator. Marks an app database table the agent can query/mutate. */
export function MuhkooDB(meta: MuhkooDBMeta): PropertyDecorator & MethodDecorator {
  return ((target: object, propertyKey: string | symbol) => {
    descriptorFor(ctorOf(target)).tables.push({
      table: meta.table ?? String(propertyKey),
      access: meta.access ?? "read",
      description: meta.description,
      backend: meta.backend ?? false,
    });
  }) as PropertyDecorator & MethodDecorator;
}

/** Member decorator. Marks a serverless function the agent can call. */
export function MuhkooFunction(meta: MuhkooFunctionMeta): PropertyDecorator & MethodDecorator {
  return ((target: object, propertyKey: string | symbol) => {
    descriptorFor(ctorOf(target)).functions.push({
      name: meta.name ?? String(propertyKey),
      description: meta.description,
    });
  }) as PropertyDecorator & MethodDecorator;
}

/** Read back the raw descriptor a class accumulated (for tooling/tests). */
export function getMuhkooAppDescriptor(appClass: Function): MuhkooAppDescriptor | undefined {
  return REGISTRY.get(appClass);
}

/**
 * Compose the agent system prompt from a `@MuhkooAgent`-decorated class. Throws
 * if the class isn't decorated. The result is the semantic layer only — the
 * runtime appends exact schema + the closed tool list at invocation time.
 */
export function ejectAgentPrompt(appClass: Function): string {
  const d = REGISTRY.get(appClass);
  if (!d || !d.agent) {
    throw new Error("ejectAgentPrompt: the class must be decorated with @MuhkooAgent");
  }
  const { agent } = d;
  const lines: string[] = [];
  lines.push(`You are ${agent.name}. ${agent.purpose}`.trim());

  if (agent.guidance?.length) {
    lines.push("", "Guidance:");
    for (const g of agent.guidance) lines.push(`- ${g}`);
  }

  if (d.spaces.length) {
    lines.push("", "Channels (Spaces) you can resolve with resolve_channel and post messages into:");
    for (const s of d.spaces) lines.push(`- ${s.name}: ${s.description}`);
  }

  // Backend-only tables are deliberately withheld — the agent should never be
  // told about server-managed / internal state it can't (and shouldn't) touch.
  const promptTables = d.tables.filter((t) => !t.backend);
  if (promptTables.length) {
    lines.push("", "App database tables:");
    for (const t of promptTables) {
      const verbs = t.access === "write"
        ? "read & write — db_query/db_get/db_insert/db_update/db_delete"
        : "read-only — db_query/db_get";
      lines.push(`- ${t.table} (${verbs}): ${t.description}`);
    }
  }

  if (d.functions.length) {
    lines.push("", "Functions you can invoke with call_function:");
    for (const f of d.functions) lines.push(`- ${f.name}: ${f.description}`);
  }

  if (agent.instructions?.trim()) {
    lines.push("", agent.instructions.trim());
  }

  // How to respond — the load-bearing behavioral contract. Without this, models
  // (especially gpt-oss) tend to run tool calls and then end their turn with no
  // user-facing message, so the user sees the work happen but gets no reply.
  const hasTools = promptTables.length > 0 || d.functions.length > 0;
  lines.push("", "How to respond:");
  if (hasTools) {
    lines.push(
      "- When you need information or need to make a change, call your tools immediately — don't ask the user to do it, and don't describe or name the tools to them.",
      "- After your tool calls return, you MUST send one final reply to the channel, in plain language, that answers the request using the results.",
    );
  }
  lines.push(
    "- Always end your turn with a short written reply (one or two sentences). Never finish with only tool calls and no message, and never reply with an empty message.",
    "- Don't restate function names, parameters, JSON, or your list of tools to the user — just give them the answer.",
  );

  lines.push(
    "",
    "The exact columns, function parameters, and the full list of callable tools are supplied to you by the runtime. Follow that authoritative list — never invent tables, columns, functions, or tools.",
  );

  return lines.join("\n");
}

/**
 * The tools-config shape the Muhkoo platform uses to gate an agent. Alias of
 * `client.agents`' {@link AgentToolsConfig} so {@link ejectAgentTools} output
 * drops straight into `client.agents.create({ tools })`.
 */
export type MuhkooAgentToolsConfig = AgentToolsConfig;

/**
 * Derive a suggested tools allowlist from a decorated class — the db tables
 * (and whether any are writable), the callable functions, and whether channels
 * are in play. Pair with {@link ejectAgentPrompt} when configuring the agent.
 *
 * If any tables/functions are present the result has `enabled: true`; to
 * actually grant tools you must also pass a function-calling `model` in the same
 * `client.agents.create`/`update` call (the server enforces this).
 */
export function ejectAgentTools(appClass: Function, opts?: { maxIterations?: number }): AgentToolsConfig {
  const d = REGISTRY.get(appClass);
  if (!d) {
    throw new Error("ejectAgentTools: the class must be decorated with @MuhkooAgent");
  }
  const anyWrite = d.tables.some((t) => t.access === "write");
  const mode = d.tables.length === 0 ? "off" : anyWrite ? "write" : "read";
  return {
    enabled: d.tables.length > 0 || d.functions.length > 0 || d.spaces.length > 0,
    db: { mode, tables: d.tables.map((t) => t.table) },
    functions: d.functions.map((f) => f.name),
    channels: d.spaces.length > 0,
    maxIterations: opts?.maxIterations ?? 6,
  };
}
