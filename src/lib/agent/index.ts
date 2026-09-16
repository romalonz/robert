// Robert Agent — a minimal agent loop over the Phase-B core (recs 13/26/27).
//
// ADDITIVE scaffolding: the live suggest()/capture path does not use this. It
// wires the platform seams together — Brain (Rust BrainProvider via a command),
// Tool registry, MemoryStore, ContextProvider, and the meeting Skill — into one
// intent→…→verify loop the app can grow into.

export * from "./types";
export * from "./intent";
export * from "./brain";
export * from "./agent";

import { Agent } from "./agent";
import { localBrain } from "./brain";
import { defaultToolRegistry, markdownMeetingMemory, desktopContext } from "../core";
import { meetingSkill } from "../skills";
import type { AgentDeps } from "./types";

/** A ready-to-run agent wired to Robert's existing tools, memory, context, the
 *  local brain, and the meeting skill. Nothing on the live path calls this yet;
 *  it is the scaffold the app grows into. */
export function createDefaultAgent(overrides: Partial<AgentDeps> = {}): Agent {
  return new Agent({
    brain: localBrain,
    tools: defaultToolRegistry(),
    memory: markdownMeetingMemory,
    context: desktopContext,
    skill: meetingSkill,
    ...overrides,
  });
}
