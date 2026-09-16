// Robert Skills — Meeting & Interview (rec 25): the FIRST skill on the core.
//
// This expresses the meeting/interview capability as a Skill: the tools it
// uses (research + note retrieval, via the core registry), the memory it keeps
// (the markdown meeting memory), the speak-policy it contributes, its pacing,
// its answer shaping, and its end-of-session summary/merge prompts.
//
// It is a structure-only boundary. The live suggest()/event loop in
// useRobert.ts is unchanged and still holds the AUTHORITATIVE copies of the
// per-turn policy; this module mirrors that same policy (referencing the shared
// prompts.ts constants and format.ts helpers) as the single, described skill.
// Migrating the live loop to consume this skill is a deliberate,
// behavior-preserving follow-up — kept out of this structural pass so the
// interview-critical path does not change.

import { defaultToolRegistry, markdownMeetingMemory } from "../core";
import { SUMMARY_SYSTEM, MERGE_SYSTEM, MEMORY_RULES } from "../prompts";
import { isNarrativeQuestion, isDepthQuestion } from "../format";
import type { AnswerShape, ConversationType, EffectiveType, MeetingEndPrompts, Skill } from "./types";

/** Marker at the top of an "Interview knowledge: ..." file. In `auto`, the skill
 *  adopts interview pacing when the selected grounding starts with it.
 *  Mirror of the live sniff in useRobert.suggest(). */
export const INTERVIEW_MARKER = /^#\s*interview knowledge/im;

/** The speak-policy contributed to the system prompt, by conversation type.
 *  Mirror of the `typeRule` in useRobert.suggest() (the live authority). */
export function speakPolicy(type: EffectiveType, forced: boolean): string {
  if (forced)
    return "I clicked Respond because I need something to say RIGHT NOW. Never WAIT. Give me 2 to 4 short speakable sentences: open by capturing the key point of what they said in my own words, then give the substance of my response, grounded in my notes where they apply. Natural and human, like I thought of it myself.";
  switch (type) {
    case "interview":
      return "This is an interview where I am being asked questions. Answer each question or prompt directed at me; if they stacked several questions, answer each briefly in order; only WAIT if they are clearly still mid-question.";
    case "listening":
      return "Someone is presenting. Stay quiet (reply WAIT) unless they directly ask me something or clearly invite my input.";
    case "discussion":
      return "This is a back-and-forth discussion. Respond when it is naturally my turn.";
    default:
      return "Infer from the flow whether a response is needed from me right now.";
  }
}

export const meetingSkill: Skill = {
  id: "meeting",
  title: "Meeting & interview copilot",
  tools: defaultToolRegistry(),
  memory: markdownMeetingMemory,

  systemPromptContribution: (type, forced) => speakPolicy(type, forced),

  resolveType: (mode: ConversationType, grounding: string): EffectiveType =>
    mode === "auto" && INTERVIEW_MARKER.test(grounding.slice(0, 400)) ? "interview" : mode,

  // Explicit modes have fixed floor-yield windows; auto returns null so the
  // core reads the conversation to decide (readConversation).
  holdMsFor: (type: EffectiveType): number | null =>
    type === "interview" ? 200 : type === "listening" ? 1000 : type === "discussion" ? 500 : null,

  // A presenter has the floor in "listening"; otherwise the skill will speak
  // when the brain judges it is our turn.
  shouldSpeak: (type: EffectiveType): boolean => type !== "listening",

  answerShape: (question: string, cap: number | null): AnswerShape => {
    // Uncapped answers ran long; default to a tight ceiling, with more room only
    // for narrative "walk me through" / depth questions. Mirror of useRobert's
    // effectiveCap.
    const effectiveCap = cap ?? (isNarrativeQuestion(question) || isDepthQuestion(question) ? 800 : 380);
    return { cap: effectiveCap, narrative: isNarrativeQuestion(question) };
  },

  onMeetingEnd: (): MeetingEndPrompts => ({
    summarySystem: SUMMARY_SYSTEM,
    mergeSystem: MERGE_SYSTEM,
    memoryRules: MEMORY_RULES,
  }),
};
