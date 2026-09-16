// Agent — intent read (pure, deterministic, testable).
//
// A cheap offline classification of what a turn is asking for, so the loop can
// decide whether to hit the web and/or the notes before spending a brain call.
// The brain can refine this later; keeping it pure keeps the loop predictable.

import type { AgentIntent } from "./types";

/** Signals the question wants fresh/external facts (→ the research tool). */
const WEB_HINTS =
  /\b(latest|today|current|currently|news|price|pricing|cost of|weather|who is|what is the|when did|release|released|version of|stock|market|how much is)\b/i;

/** Signals the question is about the user's own world (→ note retrieval). */
const NOTE_HINTS =
  /\b(we|our|us|my|mine|the project|the report|the deal|the client|last meeting|remember|the plan|the brief|the account)\b/i;

/** Read a turn into a cheap intent. `needsNotes` also defaults on for any turn
 *  with real substance (≥ 3 words), since notes are the copilot's home ground. */
export function readIntent(turn: string): AgentIntent {
  const goal = turn.trim();
  return {
    goal,
    needsWeb: WEB_HINTS.test(turn),
    needsNotes: NOTE_HINTS.test(turn) || goal.split(/\s+/).length >= 3,
  };
}
