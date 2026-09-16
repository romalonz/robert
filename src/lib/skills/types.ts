// Robert Skills — the Skill boundary (rec 25).
//
// A Skill is a capability expressed as what it ADDS to the core platform:
// a system-prompt contribution, floor/pacing policy, a speak/stay-quiet
// decision, answer shaping, and an end-of-session hook — over the core's
// tools/memory. Meeting/interview is the first Skill (see ./meeting.ts).
// Defining skills this way is what turns "meeting" from a branch inside the
// live loop into a described consumer of the platform.

import type { MemoryStore, ToolRegistry } from "../core";

/** The conversation mode the user selected. */
export type ConversationType = "auto" | "interview" | "discussion" | "listening";

/** The type actually used for pacing — `auto` can resolve to `interview`. */
export type EffectiveType = ConversationType | "interview";

/** Prompts a skill hands the core at end-of-session. */
export interface MeetingEndPrompts {
  summarySystem: string;
  mergeSystem: string;
  memoryRules: Record<string, string>;
}

/** How long/shaped a spoken answer should be for a turn. */
export interface AnswerShape {
  /** Hard character cap for the spoken answer. */
  cap: number;
  /** A roomier "walk me through" narrative answer. */
  narrative: boolean;
}

export interface Skill {
  readonly id: string;
  readonly title: string;
  /** The core tools this skill may call. */
  readonly tools: ToolRegistry;
  /** The core memory this skill reads/writes. */
  readonly memory: MemoryStore;

  /** Extra system-prompt guidance ("how eagerly to speak") for a turn. */
  systemPromptContribution(type: EffectiveType, forced: boolean): string;
  /** Resolve the effective conversation type from the mode + grounding. */
  resolveType(mode: ConversationType, grounding: string): EffectiveType;
  /** Floor-yield window (ms) for an explicit type; null = auto (core decides). */
  holdMsFor(type: EffectiveType): number | null;
  /** Whether the skill wants the floor for this type (false = stay quiet). */
  shouldSpeak(type: EffectiveType): boolean;
  /** Answer length/shape policy for a turn. */
  answerShape(question: string, cap: number | null): AnswerShape;
  /** End-of-session prompts (summarize + merge into memory). */
  onMeetingEnd(): MeetingEndPrompts;
}
