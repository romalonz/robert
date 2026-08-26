// Robert: the live meeting loop.
// Listens to the robert-engine sidecar (robert:// events), and on each completed
// turn by the other party calls the LLM brain (local Qwen via Ollama by default,
// or DeepSeek as an option) with Robert's own grounding. Robert owns its
// brain/key/model/grounding here, so the Pluely settings UI is never needed.

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  readConversation,
  matchesMyLine,
  isIgnorableTurn,
  DialogueTurn,
  ConvKind,
} from "@/lib/conversation";

// Conversation type, which tunes how eagerly Robert speaks.
export type RobertMode = "auto" | "interview" | "discussion" | "listening";
export interface RobertProcess {
  pid: number;
  bundle: string;
}

// Brain provider: "local" (Ollama, default) or one of several cloud APIs.
export type RobertProvider =
  | "local"
  | "deepseek"
  | "anthropic"
  | "openai"
  | "groq"
  | "gemini"
  | "openrouter"
  | "xai"
  | "mistral"
  | "custom";

// Cloud provider registry. All are OpenAI-compatible chat APIs except
// Anthropic, which uses its own Messages API (separate Rust command).
export const CLOUD_PROVIDERS: {
  id: Exclude<RobertProvider, "local">;
  label: string;
  baseUrl: string; // OpenAI-compatible base URL; unused for anthropic/custom
  defaultModel: string;
  keyHint: string;
}[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", keyHint: "sk-..." },
  { id: "anthropic", label: "Claude (Anthropic)", baseUrl: "", defaultModel: "claude-opus-5", keyHint: "sk-ant-..." },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5-mini", keyHint: "sk-..." },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", keyHint: "gsk_..." },
  { id: "gemini", label: "Gemini (Google)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", keyHint: "AIza..." },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", keyHint: "sk-or-..." },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4", keyHint: "xai-..." },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-large-latest", keyHint: "key" },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "", keyHint: "api key" },
];

const LS = {
  target: "robert.target",
  mode: "robert.mode",
  autostart: "robert.autostart",
  key: "robert.deepseekKey",
  model: "robert.model",
  grounding: "robert.grounding",
  exakey: "robert.exakey",
  provider: "robert.provider",
  localModel: "robert.localModel",
  notesFolder: "robert.notesFolder",
};

// ─── DEFAULT GROUNDING (persona + protocol) ───────────────────────────────────
// Best-of-breed synthesis from Parakeet AI, Cluely, Final Round AI, Natively:
//   - Parakeet: real-time, context-aware, knows when to stay silent, natural
//     backchannels, adapts to conversation flow.
//   - Cluely: ultra-concise (1-2 words to one sentence), context-aware hints,
//     never interrupts, whispers the minimum needed.
//   - Final Round AI: structured responses, confidence, STAR-method for
//     interviews, direct answers without hedging.
//   - Natively: natural flow, no robotic pauses, matches speaker energy.
export const DEFAULT_GROUNDING = `You are Robert, my discreet meeting teammate and a seasoned expert in AI, automation, software, and operations. You feed me short, sharp answers I can say almost word for word. You never speak for me; you arm me.

## Voice (composite, applied to fit the moment)
- Reigen: read the room, simplify, reassure when explaining something technical.
- Kakashi: calm, never flustered, quietly competent.
- Kunikida: organized, structured, plan and milestone minded.
- Yang Wen-li: humble, plain-spoken, respectful pushback when a call is wrong.
- Style: tight and precise, consultative, structured. No fluff. No hedging.

## Hard rules (always)
- First person, speakable, plain English.
- Sound HUMAN: contractions, everyday words, natural spoken rhythm. Like talking to a colleague, never like reading a memo. Vary how lines start; never open two lines in a row the same way.
- One to three short sentences. Lead with the direct answer, then back it with the CONCRETE SPECIFICS from my notes whenever they exist: the number, the name, the date, how it actually works. Detail beats vagueness; a specific fact beats a reassurance. But never ramble past the point.
- When my notes contain a number relevant to the question, the answer MUST include it, quoted exactly as written (row counts, dollars, times, percentages). Never round it away, never replace it with "several" or "significant".
- If they stacked multiple questions in one go, answer EACH one briefly, in the order asked. Do not drop any of them.
- No em dashes. No timelines or time estimates. No bullet points.
- Nothing disprovable or accusatory. De-escalate. Keep it true.
- Never output reasoning, chain-of-thought, labels, or meta-commentary. Only the line I would say.
- Match the other person's energy: excited → slightly warm; serious → measured; tense → lower the temperature, acknowledge, redirect.

## Conversation awareness (auto mode)
Each turn I tell you my read of the conversation type. Adapt the line's shape to it:
- Briefing/presentation by them: at each real pause, one brief acknowledgment plus one value-add or sharp question; WAIT only when they are obviously mid-sentence.
- Question at me: ONE direct, confident answer, fast.
- Challenge/pushback: acknowledge first, then one grounded fact or a polite probing question. Never defensive.
- Decision on the table: ONE clear recommendation with a one-line why.
- Status cadence: crisp factual lines, only when my area is named.
- Small talk: brief, warm, human. No business facts.
IMPORTANT: the captured audio sometimes echoes MY OWN voice back, so some transcribed lines are ME speaking, not them. Treat a line as ME (and reply EXACTLY: WAIT) when it is a first-person statement presenting or defending MY work ("the pull is read-only", "I built", "my report") or restates my talking points from the notes below. Never respond to my own words as if they were the other side's.

## Suggest mode (default)
Give me a short, natural, speakable answer (one to three sentences) I can say almost verbatim. No labels, no preamble, just the answer.
- If they ask a question → answer it directly, then add the specific fact or number from my notes that proves it.
- If they make a claim or state a fact → a brief acknowledgment + value-add. ("Nice, that aligns with what we scoped." / "Got it. One thing to flag on that…")
- If they ask my opinion or for a recommendation → ONE clear recommendation with the concrete why. No fence-sitting.
- Company specifics (names, numbers, decisions, status): use ONLY my notes below. If a specific is not there, do not invent it; give the general expert view and add that I will confirm the exact detail.
- AI, automation, software, data, integration, or process design: answer as a seasoned AI and automation engineer. Crisp, correct, confident.
- Reference what was said earlier in the meeting to show active listening. ("As we discussed earlier re: the rollout…")

## Scrutinize mode
Give me three short parts, each on its own line:
- Verdict: one word, one of grounded, unsupported, contradicted, or unverifiable.
- Why: one line. If only general knowledge, end with "general knowledge, verify".
- Ask: one clean, non-accusatory question I can say out loud to test it. Never an accusation. Never the words liar, lying, false, or bull.
The Verdict and Why are for my eyes only. The Ask is the only part I will say.

## De-escalation (when tension rises)
- Acknowledge their point first. ("I see why that's concerning.")
- Lower the temperature. Redirect to shared goal.
- Never argue. Probe with a question instead.

## MEETING KNOWLEDGE (paste your notes for this meeting below)
`;

// Backchannel/filler filtering lives in @/lib/conversation (tested by the
// harness alongside the classifier and echo matcher).

export const useRobert = () => {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("idle");
  const [processes, setProcesses] = useState<RobertProcess[]>([]);
  const [target, setTarget] = useState<string>(
    () => localStorage.getItem(LS.target) || "teams"
  );
  const [mode, setMode] = useState<RobertMode>(
    () => (localStorage.getItem(LS.mode) as RobertMode) || "auto"
  );
  const [lastRoute, setLastRoute] = useState<string>("auto");
  const [autoStart, setAutoStart] = useState<boolean>(
    () => localStorage.getItem(LS.autostart) === "1"
  );
  // Brain provider: "local" (Qwen via Ollama) by default, "deepseek" as cloud option.
  const [provider, setProvider] = useState<RobertProvider>(
    () => (localStorage.getItem(LS.provider) as RobertProvider) || "local"
  );
  // Per-provider API keys and models, so switching providers never loses a
  // key. Legacy single-provider storage (DeepSeek) migrates in transparently.
  const [cloudKeys, setCloudKeys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const p of CLOUD_PROVIDERS) {
      m[p.id] = localStorage.getItem(`robert.key.${p.id}`) || "";
    }
    if (!m.deepseek) m.deepseek = localStorage.getItem(LS.key) || "";
    return m;
  });
  const [cloudModels, setCloudModels] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const p of CLOUD_PROVIDERS) {
      m[p.id] = localStorage.getItem(`robert.model.${p.id}`) || p.defaultModel;
    }
    if (!localStorage.getItem("robert.model.deepseek")) {
      m.deepseek = localStorage.getItem(LS.model) || "deepseek-chat";
    }
    return m;
  });
  const [customBaseUrl, setCustomBaseUrl] = useState<string>(
    () => localStorage.getItem("robert.customBaseUrl") || ""
  );
  const [localModel, setLocalModel] = useState<string>(() => {
    const stored = localStorage.getItem(LS.localModel);
    // migrate old defaults to the stable call-tuned brain; keep a custom pick.
    // (-mlx crashed Metal under GPU contention; GGUF llama.cpp is stable.)
    return !stored || stored === "qwen3.8:27b" || stored === "gemma4:12b-mlx"
      ? "gemma4:12b"
      : stored;
  });
  const [exaKey, setExaKey] = useState<string>(
    () => localStorage.getItem(LS.exakey) || ""
  );
  const [grounding, setGrounding] = useState<string>(
    () => localStorage.getItem(LS.grounding) || DEFAULT_GROUNDING
  );
  const [groundingSource, setGroundingSource] = useState<string>("");
  // Folder of .md files Robert grounds on (an Obsidian vault works as-is).
  const [notesFolder, setNotesFolder] = useState<string>(
    () => localStorage.getItem(LS.notesFolder) || "~/RobertNotes"
  );
  const [partial, setPartial] = useState("");
  const [lastTurn, setLastTurn] = useState("");
  const [suggestion, setSuggestion] = useState("");
  // Recent answers, newest first, each with the turn it answered. Rapid-fire
  // questioning must not wipe the answer to the previous question. Entries
  // age out so the window retracts to its default size once the moment passes.
  const [answers, setAnswers] = useState<
    { text: string; turn: string; at: number }[]
  >([]);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // refs so the event-driven suggest() always reads the latest values
  const modeRef = useRef(mode);
  const providerRef = useRef(provider);
  const cloudKeysRef = useRef(cloudKeys);
  const cloudModelsRef = useRef(cloudModels);
  const customBaseUrlRef = useRef(customBaseUrl);
  const localModelRef = useRef(localModel);
  const groundingRef = useRef(grounding);
  const exaKeyRef = useRef(exaKey);
  const notesFolderRef = useRef(notesFolder);
  notesFolderRef.current = notesFolder;
  modeRef.current = mode;
  providerRef.current = provider;
  cloudKeysRef.current = cloudKeys;
  cloudModelsRef.current = cloudModels;
  customBaseUrlRef.current = customBaseUrl;
  localModelRef.current = localModel;
  groundingRef.current = grounding;
  exaKeyRef.current = exaKey;
  const reqIdRef = useRef(0);
  // id of the request whose answer currently owns the main display. Answers
  // display monotonically: a finished answer newer than what is shown takes
  // the screen NOW, even while an even-newer request is still generating —
  // otherwise rapid-fire questions leave the previous answer stuck on screen
  // until the whole queue drains.
  const displayedIdRef = useRef(0);
  const didAutoStart = useRef(false);
  // Closed dialogue history (Them/Me labeled) for coherence. A "them" entry is
  // pushed when a segment gets answered; a "me" entry when I read a suggestion.
  const historyRef = useRef<DialogueTurn[]>([]);
  const segmentRef = useRef<string[]>([]); // everything said since I last responded
  const partialRef = useRef<string>(""); // latest in-progress (not yet final) line
  const mySuggestionsRef = useRef<string[]>([]); // last lines Robert showed me
  const myLastLineRef = useRef<string>(""); // last line I actually said out loud
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // floor-yield window
  const lastHoldMsRef = useRef(950);
  const [convKind, setConvKind] = useState<ConvKind | "">("");

  useEffect(() => localStorage.setItem(LS.target, target), [target]);
  useEffect(() => localStorage.setItem(LS.mode, mode), [mode]);
  useEffect(
    () => localStorage.setItem(LS.autostart, autoStart ? "1" : "0"),
    [autoStart]
  );
  useEffect(() => {
    for (const p of CLOUD_PROVIDERS) {
      localStorage.setItem(`robert.key.${p.id}`, cloudKeys[p.id] || "");
    }
  }, [cloudKeys]);
  useEffect(() => {
    for (const p of CLOUD_PROVIDERS) {
      localStorage.setItem(`robert.model.${p.id}`, cloudModels[p.id] || "");
    }
  }, [cloudModels]);
  useEffect(
    () => localStorage.setItem("robert.customBaseUrl", customBaseUrl),
    [customBaseUrl]
  );
  useEffect(() => localStorage.setItem(LS.localModel, localModel), [localModel]);
  useEffect(() => localStorage.setItem(LS.exakey, exaKey), [exaKey]);
  useEffect(() => localStorage.setItem(LS.grounding, grounding), [grounding]);
  useEffect(() => localStorage.setItem(LS.provider, provider), [provider]);
  useEffect(() => localStorage.setItem(LS.notesFolder, notesFolder), [notesFolder]);

  const suggest = useCallback(async (turnText: string, force = false) => {
    const type = modeRef.current; // conversation type
    const prov = providerRef.current; // brain provider
    const id = ++reqIdRef.current;
    // keep the current answer on screen until a new one is ready (and on WAIT)
    setSuggesting(true);
    setError(null);

    // Route to the local brain (Ollama) or the selected cloud provider.
    const askBrain = async (user: string): Promise<string> => {
      if (prov === "local") {
        return await invoke<string>("robert_suggest_local", {
          model: localModelRef.current || "gemma4:12b",
          system: groundingRef.current,
          user,
        });
      }
      const meta = CLOUD_PROVIDERS.find((p) => p.id === prov);
      const key = (cloudKeysRef.current[prov] || "").trim();
      if (!key)
        throw new Error(
          `Add your ${meta?.label ?? prov} API key in settings.`
        );
      const mdl = (cloudModelsRef.current[prov] || meta?.defaultModel || "").trim();
      if (prov === "anthropic") {
        return await invoke<string>("robert_suggest_anthropic", {
          apiKey: key,
          model: mdl || "claude-opus-5",
          system: groundingRef.current,
          user,
        });
      }
      const baseUrl =
        prov === "custom" ? customBaseUrlRef.current.trim() : meta?.baseUrl || "";
      if (prov === "custom" && !baseUrl)
        throw new Error("Set the custom provider's base URL in settings.");
      return await invoke<string>("robert_suggest", {
        apiKey: key,
        model: mdl,
        system: groundingRef.current,
        user,
        baseUrl,
      });
    };
    const exa = async (query: string) => {
      if (!exaKeyRef.current.trim())
        throw new Error("Add your Exa API key in settings for research.");
      return await invoke<string>("robert_research", {
        apiKey: exaKeyRef.current.trim(),
        query,
      });
    };
    // How eagerly to speak, by conversation type (or a forced manual request).
    const typeRule = force
      ? "I clicked Respond because I need something to say RIGHT NOW. Never WAIT. Give me 2 to 4 short speakable sentences: open by capturing the key point of what they said in my own words, then give the substance of my response, grounded in my notes where they apply. Natural and human, like I thought of it myself."
      : type === "interview"
      ? "This is an interview where I am being asked questions. Answer each question or prompt directed at me; if they stacked several questions, answer each briefly in order; only WAIT if they are clearly still mid-question."
      : type === "listening"
      ? "Someone is presenting. Stay quiet (reply WAIT) unless they directly ask me something or clearly invite my input."
      : type === "discussion"
      ? "This is a back-and-forth discussion. Respond when it is naturally my turn."
      : "Infer from the flow whether a response is needed from me right now.";

    try {
      let out = "";
      let route = "suggest";
      let wait = false;
      const hist = historyRef.current
        .slice(-12)
        .map((t) => `${t.who === "me" ? "Me" : "Them"}: ${t.text.slice(0, 400)}`)
        .join("\n");
      const segment = (segmentRef.current.join(" ") + " " + partialRef.current)
        .trim()
        .slice(-6000);
      // conversation read: auto mode adapts; explicit modes keep their rule
      const read = readConversation(historyRef.current, segment);
      const readHint =
        type === "auto" ? `My read of the conversation: ${read.hint}\n` : "";
      const prompt =
        (hist ? `Conversation so far (Them = the other side, Me = me):\n${hist}\n\n` : "") +
        (myLastLineRef.current
          ? `The last thing I said out loud: "${myLastLineRef.current}"\n\n`
          : "") +
        `The other side is saying this now. Treat it as ONE message and respond to the WHOLE thing, even if it is several sentences:\n${segment || turnText}\n\n` +
        readHint +
        `${typeRule}\n` +
        `- They have already paused by the time you see this. Reply EXACTLY WAIT only if they are clearly mid-thought, or the text sounds like my own voice echoed back. When in doubt, give me a line.\n` +
        `- If a good answer needs current or external info you are not sure of, reply EXACTLY: NEEDS_RESEARCH: <focused web query>\n` +
        `- Otherwise give me a short, natural, speakable answer (one to three sentences) I can say almost verbatim, using the concrete specifics from my notes when they apply. If a claim seems off, make it a polite probing question. No labels, just the answer.`;
      const asked = segment || turnText; // what this request is answering
      let first = (await askBrain(prompt)).trim();
      // forced but it still hesitated: ask plainly for a line.
      if (force && /^WAIT\b/i.test(first)) {
        first = (
          await askBrain(
            `They just said:\n"${turnText}"\n\nI need something to say right now. Give me 2 to 4 short, natural, speakable sentences: capture their key point in my words, then my response.`
          )
        ).trim();
      }
      if (!force && /^WAIT\b/i.test(first)) {
        wait = true;
        route = "wait";
      } else if (/^\s*NEEDS_RESEARCH\s*:/i.test(first)) {
        const q = first.replace(/^\s*NEEDS_RESEARCH\s*:/i, "").trim() || turnText;
        if (id === reqIdRef.current) {
          route = "research";
          out = await exa(q);
        }
      } else {
        route = "suggest";
        out = first;
      }
      const line = out.trim();
      if (!wait && line) {
        // Keep the answer even if a newer question superseded this request:
        // in rapid-fire questioning the answer to question 1 must survive
        // question 2 landing while it was being generated.
        mySuggestionsRef.current = [...mySuggestionsRef.current, line].slice(-5);
        setAnswers((prev) =>
          prev.some((a) => a.text === line)
            ? prev
            : [{ text: line, turn: asked.slice(-160), at: Date.now() }, ...prev].slice(0, 3)
        );
        // Monotonic display: newest finished answer takes the screen now.
        if (id > displayedIdRef.current) {
          displayedIdRef.current = id;
          setSuggestion(line);
          setLastRoute(route);
        }
      }
      if (id === reqIdRef.current) {
        if (!wait) {
          // segment addressed: close it into history, fresh one for what's next
          const closed = segmentRef.current.join(" ").trim();
          if (closed) {
            historyRef.current = [
              ...historyRef.current,
              { who: "them" as const, text: closed },
            ].slice(-12);
          }
          segmentRef.current = [];
          partialRef.current = "";
        }
        setLastRoute(route);
      }
    } catch (e: any) {
      if (id === reqIdRef.current) setError(String(e));
    } finally {
      if (id === reqIdRef.current) setSuggesting(false);
    }
  }, []);

  // Manual trigger: force a response to the last completed turn (human-in-the-loop).
  const respondNow = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    // Respond to the whole segment they've spoken since I last replied, plus any
    // in-progress line, so a long presentation gets a complete-context answer.
    const full = (segmentRef.current.join(" ") + " " + partialRef.current).trim();
    if (!full) {
      setError("Nothing captured yet to respond to.");
      return;
    }
    suggest(full, true);
  }, [suggest]);

  useEffect(() => {
    const clearHold = () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
    const armHold = (turnText: string, holdMs: number) => {
      clearHold();
      lastHoldMsRef.current = holdMs;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        suggest(turnText);
      }, holdMs);
    };
    const unEvent = listen<string>("robert://event", (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.payload);
      } catch {
        return;
      }
      switch (msg.type) {
        case "status":
          setStatus(msg.stage);
          if (msg.stage === "ready") setError(null);
          break;
        case "partial": {
          const p = msg.text || "";
          setPartial(p);
          partialRef.current = p;
          // speech resumed: the floor was NOT yielded, keep accumulating
          if (p.trim()) clearHold();
          break;
        }
        case "final": {
          setPartial("");
          partialRef.current = "";
          const t = (msg.text || "").trim();
          // Ignore pure backchannel/filler ("okay", "mm-hmm") and Whisper
          // silence hallucinations so they never wipe the real answer. But
          // re-arm a pending answer the preceding partials canceled.
          if (!t || isIgnorableTurn(t)) {
            if (segmentRef.current.length && !holdTimerRef.current) {
              armHold(segmentRef.current.join(" "), lastHoldMsRef.current);
            }
            break;
          }
          // Me reading Robert's line aloud (or its far-end echo): not a turn
          // to answer. Record it as my side of the dialogue and stand by.
          if (matchesMyLine(t, mySuggestionsRef.current)) {
            clearHold();
            myLastLineRef.current = t;
            historyRef.current = [
              ...historyRef.current,
              { who: "me" as const, text: t },
            ].slice(-12);
            setLastRoute("delivered");
            // line delivered: collapse the stacked extras so the window
            // retracts back toward its default size
            setAnswers((prev) => (prev.length > 1 ? prev.slice(0, 1) : prev));
            break;
          }
          segmentRef.current = [...segmentRef.current, t];
          setLastTurn(t);
          // Floor-yield window: answer once they actually stop, not per
          // sentence. Auto adapts to the conversation read; explicit modes
          // have fixed windows (interview answers fast, listening holds).
          const m = modeRef.current;
          let holdMs: number;
          if (m === "interview") holdMs = 650;
          else if (m === "listening") holdMs = 1600;
          else if (m === "discussion") holdMs = 950;
          else {
            const read = readConversation(
              historyRef.current,
              segmentRef.current.join(" ")
            );
            setConvKind(read.kind);
            holdMs = read.holdMs;
          }
          armHold(t, holdMs);
          break;
        }
        case "error":
          setError(msg.message || "Engine error.");
          break;
        default:
          break;
      }
    });
    const unTerm = listen<number | null>("robert://terminated", () => {
      setRunning(false);
      setStatus("stopped");
    });
    return () => {
      clearHold();
      unEvent.then((f) => f());
      unTerm.then((f) => f());
    };
  }, [suggest]);

  // Age out stacked answers so the window retracts to its default size once
  // the rapid-fire moment has passed (the latest answer stays on screen via
  // the main suggestion display).
  useEffect(() => {
    const t = setInterval(() => {
      setAnswers((prev) => {
        const now = Date.now();
        const kept = prev.filter((a) => now - a.at < 75_000);
        return kept.length === prev.length ? prev : kept;
      });
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  const refreshProcesses = useCallback(async () => {
    try {
      const list = await invoke<any[]>("robert_list_processes");
      setProcesses(
        list
          .filter((p) => p.type === "process")
          .map((p) => ({ pid: p.pid, bundle: p.bundle }))
      );
    } catch (e: any) {
      setError(String(e));
    }
  }, []);

  const start = useCallback(
    async (opts?: { bundle?: string; pid?: number }) => {
      setError(null);
      setSuggestion("");
      setAnswers([]);
      setLastTurn("");
      setPartial("");
      setConvKind("");
      historyRef.current = [];
      segmentRef.current = [];
      mySuggestionsRef.current = [];
      myLastLineRef.current = "";
      setStatus("loading_model");
      try {
        await invoke("robert_start", {
          targetBundle: opts?.pid ? null : opts?.bundle ?? target,
          targetPid: opts?.pid ?? null,
          modelFolder: null,
          silenceMs: null,
        });
        setRunning(true);
        // Prime the brain so turn one is as fast as turn ten. Fire and forget.
        // Local: loads the model + evaluates the grounding KV prefix in Ollama.
        // DeepSeek: warms its remote context cache (other clouds have none).
        if (providerRef.current === "local") {
          invoke("robert_prewarm_local", {
            model: localModelRef.current || "gemma4:12b",
            system: groundingRef.current,
          }).catch(() => {});
        } else if (
          providerRef.current === "deepseek" &&
          (cloudKeysRef.current.deepseek || "").trim()
        ) {
          invoke("robert_prewarm_cache", {
            apiKey: cloudKeysRef.current.deepseek.trim(),
            model: cloudModelsRef.current.deepseek || "deepseek-chat",
            system: groundingRef.current,
          }).catch(() => {});
        }
      } catch (e: any) {
        setError(String(e));
        setStatus("error");
      }
    },
    [target]
  );

  const stop = useCallback(async () => {
    try {
      await invoke("robert_stop");
    } catch {
      /* ignore */
    }
    setRunning(false);
    setStatus("idle");
  }, []);

  // Track previous target so we can detect changes and auto-restart the engine.
  // Debounced so typing "brave" one letter at a time does not restart 5 times.
  const prevTargetRef = useRef(target);
  useEffect(() => {
    if (prevTargetRef.current === target) return;
    prevTargetRef.current = target;
    if (!running || !target.trim()) return;
    const newTarget = target.trim();
    const t = setTimeout(() => {
      // Target changed while engine is running — restart to re-tap the new process.
      stop().then(() => {
        setTimeout(() => start({ bundle: newTarget }), 300);
      });
    }, 600);
    return () => clearTimeout(t);
  }, [target, running, stop, start]);

  // Load grounding from the notes folder: robert-brief.md wins (meeting prep),
  // else all .md files in the folder (Obsidian vault friendly).
  const reloadGrounding = useCallback(async () => {
    try {
      const g = await invoke<{ source: string; content: string }>(
        "robert_load_grounding",
        { notesFolder: notesFolderRef.current }
      );
      const full = DEFAULT_GROUNDING + "\n" + g.content;
      setGrounding(full);
      // update the ref immediately so a prewarm right after load (before the
      // re-render commits) caches the real grounding prefix, not the default
      groundingRef.current = full;
      setGroundingSource(g.source);
      setError(null);
    } catch (e: any) {
      // keep the default persona grounding if nothing is on disk
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reloadGrounding();
  }, [reloadGrounding]);

  // Re-ground when the notes folder changes (debounced while typing a path).
  useEffect(() => {
    const t = setTimeout(() => reloadGrounding(), 800);
    return () => clearTimeout(t);
  }, [notesFolder, reloadGrounding]);

  // Auto-start once on open if enabled.
  // The local brain needs no API key; cloud providers do.
  useEffect(() => {
    const needsKey =
      providerRef.current !== "local" &&
      !(cloudKeysRef.current[providerRef.current] || "").trim();
    if (autoStart && !didAutoStart.current && !needsKey) {
      didAutoStart.current = true;
      // load grounding first so the prewarm caches the real prefix
      reloadGrounding().finally(() => start());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeCloud: Exclude<RobertProvider, "local"> =
    provider === "local" ? "deepseek" : provider;

  return {
    running,
    status,
    processes,
    target,
    setTarget,
    mode,
    setMode,
    lastRoute,
    convKind,
    autoStart,
    setAutoStart,
    provider,
    setProvider,
    // key/model of the ACTIVE cloud provider (falls back to deepseek while
    // provider is "local" so the settings UI always has a value to show)
    apiKey: cloudKeys[activeCloud] ?? "",
    setApiKey: (v: string) =>
      setCloudKeys((prev) => ({ ...prev, [activeCloud]: v })),
    model: cloudModels[activeCloud] ?? "",
    setModel: (v: string) =>
      setCloudModels((prev) => ({ ...prev, [activeCloud]: v })),
    customBaseUrl,
    setCustomBaseUrl,
    localModel,
    setLocalModel,
    exaKey,
    setExaKey,
    grounding,
    setGrounding,
    groundingSource,
    notesFolder,
    setNotesFolder,
    reloadGrounding,
    partial,
    lastTurn,
    suggestion,
    answers,
    suggesting,
    error,
    refreshProcesses,
    start,
    stop,
    respondNow,
  };
};