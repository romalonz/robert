// Robert Agent — the loop scaffold (recs 13/26/27).
//
// A minimal, REAL agent loop over the Phase-B interfaces:
//   intent → context → retrieve → plan → tool → observe → reason → act → verify
// It reasons with a Brain (the Rust BrainProvider via a command), gathers a
// ContextProvider, retrieves from a MemoryStore, and calls Tools from the
// registry. This is ADDITIVE scaffolding — the live suggest()/capture path does
// not use it and is byte-for-byte unchanged. It is the start, not the frontier:
// no desktop-control (click/type), no external connectors, no vector DB.

import type { ContextProvider, MemoryStore, ToolRegistry } from "../core";
import type { Skill } from "../skills";

/** A minimal brain the agent reasons with. Backed by the Rust BrainProvider
 *  seam through a Tauri command (see ./brain.ts::localBrain). */
export interface Brain {
  chat(system: string, user: string, maxTokens?: number): Promise<string>;
}

/** The stages of one agent turn, in order. */
export type AgentStage =
  | "intent"
  | "context"
  | "retrieve"
  | "plan"
  | "tool"
  | "observe"
  | "reason"
  | "act"
  | "verify";

/** A cheap read of what the turn is asking for. */
export interface AgentIntent {
  goal: string;
  needsWeb: boolean;
  needsNotes: boolean;
}

/** The result of running one tool. */
export interface Observation {
  tool: string;
  output: string;
  ok: boolean;
}

/** One recorded step of the loop (for inspection/debugging). */
export interface AgentStep {
  stage: AgentStage;
  detail: string;
}

/** The outcome of one agent turn. */
export interface AgentResult {
  answer: string;
  intent: AgentIntent;
  observations: Observation[];
  trace: AgentStep[];
  verified: boolean;
}

/** The core platform pieces the agent runs over (all Phase-B interfaces). */
export interface AgentDeps {
  brain: Brain;
  tools: ToolRegistry;
  memory: MemoryStore;
  context: ContextProvider;
  skill?: Skill;
}

export interface AgentOptions {
  notesFolder?: string | null;
  notesFile?: string | null;
  /** Hard character cap for the spoken answer (default: the skill's shape). */
  maxChars?: number;
}
