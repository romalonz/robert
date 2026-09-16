// Agent — the loop.
//
// intent → context → retrieve → plan → tool → observe → reason → act → verify.
// Every external call is guarded so the loop degrades gracefully (offline, no
// notes, tool failure) instead of throwing. It records a `trace` for
// inspection. This is the minimal real loop; growing it (more tools, real
// planning, desktop actions) is future work and deliberately not built here.

import type { Skill } from "../skills";
import type {
  AgentDeps,
  AgentOptions,
  AgentResult,
  AgentStage,
  AgentStep,
  Observation,
} from "./types";
import { readIntent } from "./intent";

export class Agent {
  constructor(private deps: AgentDeps) {}

  async run(turn: string, opts: AgentOptions = {}): Promise<AgentResult> {
    const trace: AgentStep[] = [];
    const step = (stage: AgentStage, detail: string): void => {
      trace.push({ stage, detail });
    };
    const clip = (s: string): string => s.replace(/\s+/g, " ").slice(0, 140);

    // 1. intent
    const intent = readIntent(turn);
    step("intent", `goal="${clip(intent.goal)}" web=${intent.needsWeb} notes=${intent.needsNotes}`);

    // 2. context (grounding from the notes folder + memory)
    let grounding = "";
    try {
      const g = await this.deps.context.grounding({
        notesFolder: opts.notesFolder,
        notesFile: opts.notesFile,
      });
      grounding = g.content;
      step("context", `grounding: ${g.source}`);
    } catch (e) {
      step("context", `grounding unavailable: ${clip(String(e))}`);
    }

    // 3. retrieve (per-question paragraphs from notes + memory)
    let notes = "";
    if (intent.needsNotes) {
      try {
        notes = await this.deps.memory.search(intent.goal, {
          notesFolder: opts.notesFolder,
          prefer: opts.notesFile ?? null,
        });
        step("retrieve", notes ? `retrieved ${notes.length} chars` : "no relevant notes");
      } catch (e) {
        step("retrieve", `retrieval failed: ${clip(String(e))}`);
      }
    } else {
      step("retrieve", "skipped (intent needs no notes)");
    }

    // 4. plan (which registered tools to call)
    const plan: string[] = [];
    if (intent.needsWeb && this.deps.tools.has("research")) plan.push("research");
    step("plan", plan.length ? `tools: ${plan.join(", ")}` : "no tools; answer from context");

    // 5-6. tool + observe
    const observations: Observation[] = [];
    for (const tool of plan) {
      step("tool", `calling ${tool}`);
      try {
        const output = String(await this.deps.tools.run(tool, { query: intent.goal }));
        observations.push({ tool, output, ok: true });
        step("observe", `${tool}: ${clip(output)}`);
      } catch (e) {
        observations.push({ tool, output: String(e), ok: false });
        step("observe", `${tool} failed: ${clip(String(e))}`);
      }
    }

    // 7. reason (synthesize a speakable answer over context + observations)
    const cap = opts.maxChars ?? this.deps.skill?.answerShape(intent.goal, null).cap ?? 380;
    const budget = Math.min(480, Math.ceil(cap / 3.5) + 60);
    let answer = "";
    try {
      answer = (
        await this.deps.brain.chat(
          this.composeSystem(grounding, this.deps.skill),
          this.composeUser(turn, notes, observations),
          budget
        )
      ).trim();
      step("reason", answer ? `answer: ${clip(answer)}` : "empty answer");
    } catch (e) {
      step("reason", `brain failed: ${clip(String(e))}`);
    }

    // 8. act — for this scaffold the action is producing the speakable answer.
    // Desktop-control tools (click/type) and external connectors are the
    // frontier and are deliberately NOT part of this loop.
    step("act", answer ? "produced a speakable answer" : "no answer produced");

    // 9. verify — minimal: a non-empty answer, not wildly over the cap.
    const verified = answer.length > 0 && answer.length <= cap * 1.5;
    step("verify", verified ? "passed" : "failed (empty or over cap)");

    return { answer, intent, observations, trace, verified };
  }

  private composeSystem(grounding: string, skill?: Skill): string {
    const parts = [
      "You are Robert, a local-first AI copilot. Give ONE short, natural, speakable reply.",
    ];
    if (skill) parts.push(skill.systemPromptContribution("auto", false));
    if (grounding) parts.push(`My notes / grounding:\n${grounding}`);
    return parts.join("\n\n");
  }

  private composeUser(turn: string, notes: string, observations: Observation[]): string {
    const parts = [`They said/asked: ${turn}`];
    if (notes) parts.push(`Relevant notes:\n${notes}`);
    const obs = observations
      .filter((o) => o.ok)
      .map((o) => `- [${o.tool}] ${o.output}`)
      .join("\n");
    if (obs) parts.push(`Tool results:\n${obs}`);
    return parts.join("\n\n");
  }
}
