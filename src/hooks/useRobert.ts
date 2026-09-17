// Robert: the live meeting loop.
// Listens to the robert-engine sidecar (robert:// events), and on each completed
// turn by the other party calls the LLM brain (local Qwen via Ollama by default,
// or DeepSeek as an option) with Robert's own grounding. Robert owns its
// brain/key/model/grounding here, so the Pluely settings UI is never needed.

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  readConversation,
  matchesMyLine,
  isIgnorableTurn,
  type ConvContext,
  humanizeLine,
  DialogueTurn,
  ConvKind,
} from "@/lib/conversation";
import { parseAliases } from "@/lib/group";
import { extractAnswerFormat, capToFormat, normalizeBullets, capFor, isNarrativeQuestion, isDepthQuestion } from "@/lib/format";
import { VOICES, VOICE_MAX } from "@/lib/voices";
import { parseRobertEvent, type RobertToken } from "@/lib/events";
import {
  DEFAULT_VOICE,
  DEFAULT_RULES,
  NOTES_HEADER,
  DEFAULT_ANSWER_FORMAT,
  composeVoiceText,
  extractVoice,
  STALL_DIRECT,
  STALL_NARRATIVE,
  SUMMARY_SYSTEM,
  MERGE_SYSTEM,
  MEMORY_RULES,
  CONVERT_SYSTEM,
  SOLVE_SYSTEM,
  MEETING_PRESENCE,
} from "@/lib/prompts";

// Conversation type, which tunes how eagerly Robert speaks.
export type RobertMode = "auto" | "interview" | "discussion" | "listening";
export interface RobertProcess {
  pid: number;
  bundle: string;
}
export interface MeetingInfo {
  id: string;
  dir: string;
  started: string;
  target: string;
  turns: number;
  has_summary: boolean;
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
  provider: "robert.provider",
  localModel: "robert.localModel",
  notesFolder: "robert.notesFolder",
};

// The default local brain, in ONE place (mirrors LOCAL_BRAIN in local_brain.rs).
// A dense 4B: ~1/3 the size of the old gemma4:12b, so it generates 2-3x faster on
// a CPU-bound PC — the real bottleneck when answering during a live call — while
// retrieval still supplies the facts so grounded answers hold up. Flip here to
// change the default everywhere on the frontend.
const LOCAL_BRAIN = "gemma3:4b";

export const useRobert = () => {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("idle");
  const [processes, setProcesses] = useState<RobertProcess[]>([]);
  const [target, setTarget] = useState<string>(
    () => localStorage.getItem(LS.target) || "teams"
  );
  const [mode, setMode] = useState<RobertMode>(() => {
    const m = localStorage.getItem(LS.mode) as RobertMode | null;
    // Interview and Discuss buttons are gone: Auto covers both
    return m === "listening" ? "listening" : "auto";
  });
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
    // An explicit pick always wins (the settings dropdown sets localModelChosen),
    // so a machine deliberately set to 12b (or 4b) keeps it.
    if (localStorage.getItem("robert.localModelChosen") === "1" && stored) return stored;
    // Otherwise normalize only truly-dead tags to a safe start. The platform-aware
    // robert_local_recommend sets the REAL default (12b on mac, light 4B on
    // Windows) and re-applies once via the effect below — so the Mac's 12b is
    // never forced down and Windows moves to the fast 4B.
    return !stored || stored === "qwen3.8:27b" || stored === "gemma4:12b-mlx"
      ? "gemma4:12b"
      : stored;
  });
  // The brain's briefing has two parts, kept separate on purpose:
  // - persona: generic behavior rules, user-editable, persisted.
  // - notes: meeting-specific knowledge, read-only here — it always comes
  //   from the .md files in the notes folder, never from the app.
  // Persona & rules live in a file, like all knowledge: <notes>/_persona.md.
  // Seeded with the default on first run; edited with any editor; app updates
  // to the default still apply while the file is untouched ("personaBase"
  // records the default that was current when the file was written).
  // `persona` here holds the VOICE text (the swappable part). The rules are
  // fixed in DEFAULT_RULES and always applied.
  const [persona, setPersona] = useState<string>(DEFAULT_VOICE);
  const [personaCustomized, setPersonaCustomized] = useState<boolean>(false);
  const PERSONA_FILE = "_persona.md";
  // Group calls: my name (plus how people mispronounce it) and the call type.
  const [myName, setMyName] = useState<string>(
    () => localStorage.getItem("robert.myName") || ""
  );
  const [callType, setCallType] = useState<"auto" | "one" | "group">(
    () => (localStorage.getItem("robert.callType") as any) || "auto"
  );
  const [participants, setParticipants] = useState<string[]>([]); // names heard this call
  // Solve screen (technical-interview vision): local vision model + result panel
  const [visionModel, setVisionModel] = useState<string>(
    () => localStorage.getItem("robert.visionModel") || "qwen2.5vl:7b"
  );
  const [screenAnswer, setScreenAnswer] = useState<string>("");
  const [screenSolving, setScreenSolving] = useState<boolean>(false);
  const [screenError, setScreenError] = useState<string>("");
  // Knowledge inbox (files dropped/uploaded, waiting to be rewritten to spec)
  const [inbox, setInbox] = useState<string[]>([]);
  const [convertStatus, setConvertStatus] = useState<string>("");
  const [converting, setConverting] = useState<string>(""); // file being converted
  // Files dropped into the notes folder are always converted: non-negotiable.
  const autoConvert = true;
  // Local brain (Ollama + model) status and one-click setup progress
  const [localStatus, setLocalStatus] = useState<{
    installed: boolean;
    running: boolean;
    models: string[];
    has_model: boolean;
  } | null>(null);
  const [localSetup, setLocalSetup] = useState<{
    stage: string;
    status: string;
    completed: number;
    total: number;
  } | null>(null);
  // This machine's total RAM (GB). Drives the low-RAM warning that steers weak
  // PCs to a cloud brain — a local model that doesn't fit pages to disk and
  // slows the whole system. 0 = unknown/not yet read.
  const [localRamGb, setLocalRamGb] = useState<number>(0);
  // Windows only: which system-output device Robert captures (loopback). "" =
  // the Windows default, which is often the WRONG endpoint when several outputs
  // are active or a virtual device (Krisp) is in play — so let the user pick the
  // speaker the meeting actually plays through.
  const [outputDevice, setOutputDevice] = useState<string>(
    () => localStorage.getItem("robert.outputDevice") || ""
  );
  const outputDeviceRef = useRef(outputDevice);
  outputDeviceRef.current = outputDevice;
  useEffect(() => localStorage.setItem("robert.outputDevice", outputDevice), [outputDevice]);
  const [outputDevices, setOutputDevices] = useState<
    { id: string; name: string; is_default: boolean }[]
  >([]);
  const refreshOutputDevices = useCallback(() => {
    invoke<{ id: string; name: string; is_default: boolean }[]>("get_output_devices")
      .then((d) => setOutputDevices(Array.isArray(d) ? d : []))
      .catch(() => setOutputDevices([]));
  }, []);
  // Consent gate: nothing is installed/downloaded until the user says Continue.
  const [setupConsent, setSetupConsent] = useState<boolean>(false);
  const [pendingSetup, setPendingSetup] = useState<null | "brain" | "vision">(null);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [modelsLocation, setModelsLocation] = useState<string>("");
  // Persona voice: anime characters composed into _persona.md's Voice section.
  const [selectedVoices, setSelectedVoices] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("robert.voices") || "[]"); } catch { return []; }
  });
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const selectedVoicesRef = useRef(selectedVoices);
  selectedVoicesRef.current = selectedVoices;
  // First-run onboarding: résumé, then voice, then set up the local brain.
  // Only ever runs on a FRESH install; a configured machine is detected and
  // marked onboarded so it never appears again.
  const [onboardingStep, setOnboardingStep] = useState<null | "resume" | "voice">(null);
  const [addressedTo, setAddressedTo] = useState<string>(""); // who the last line was for
  const [notes, setNotes] = useState<string>("");
  const [groundingSource, setGroundingSource] = useState<string>("");
  // Folder of .md files Robert grounds on (an Obsidian vault works as-is).
  const [notesFolder, setNotesFolder] = useState<string>(
    () => localStorage.getItem(LS.notesFolder) || "~/RobertNotes"
  );
  // Meeting Memory (Fathom-like, local): transcript logging per meeting,
  // takeaways + memory merge on Stop, learned memory injected into grounding.
  const [recordMeetings, setRecordMeetings] = useState<boolean>(
    () => localStorage.getItem("robert.recordMeetings") !== "0"
  );
  // Microphone capture (macOS only, opt-in, OFF by default): also record MY own
  // spoken answers as "me" turns via the engine's --mic stream. When off, the
  // engine captures only the other party's system audio, exactly as before.
  const [micCapture, setMicCapture] = useState<boolean>(
    () => localStorage.getItem("robert.micCapture") === "1"
  );
  const micCaptureRef = useRef(micCapture);
  micCaptureRef.current = micCapture;
  // What Robert learned from past meetings is always used: non-negotiable.
  const useMemory = true;
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [postMeeting, setPostMeeting] = useState<string>(""); // status after Stop
  const meetingDirRef = useRef<string>("");
  // Optional explicit selection: ground on ONE file from the folder.
  // "" = Auto (robert-brief.md wins, else all notes combined).
  const [notesFile, setNotesFile] = useState<string>(
    () => localStorage.getItem("robert.notesFile") || ""
  );
  const [notesList, setNotesList] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [lastTurn, setLastTurn] = useState("");
  // Live diagnostics: how many turns were heard vs answered this session —
  // tells at a glance whether transcription or the brain is the dead half.
  const [turnsHeard, setTurnsHeard] = useState(0);
  const [answersGiven, setAnswersGiven] = useState(0);
  const turnsHeardRef = useRef(0);
  const answersGivenRef = useRef(0);
  turnsHeardRef.current = turnsHeard;
  answersGivenRef.current = answersGiven;
  // One-shot brain/key check, surfaced inline in settings.
  const [brainTest, setBrainTest] = useState<{
    status: "idle" | "testing" | "ok" | "fail";
    detail: string;
  }>({ status: "idle", detail: "" });
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
  const personaRef = useRef(persona);
  const notesRef = useRef(notes);
  const notesFolderRef = useRef(notesFolder);
  notesFolderRef.current = notesFolder;
  const notesFileRef = useRef(notesFile);
  notesFileRef.current = notesFile;
  const recordMeetingsRef = useRef(recordMeetings);
  recordMeetingsRef.current = recordMeetings;
  const useMemoryRef = useRef(useMemory);
  const myNameRef = useRef(myName);
  myNameRef.current = myName;
  const callTypeRef = useRef(callType);
  callTypeRef.current = callType;
  const rosterRef = useRef<string[]>([]); // colleague names heard this call
  const visionModelRef = useRef(visionModel);
  visionModelRef.current = visionModel;
  const localStatusRef = useRef(localStatus);
  localStatusRef.current = localStatus;
  const diskFreeRef = useRef<number | null>(null);
  const setupConsentRef = useRef(setupConsent);
  setupConsentRef.current = setupConsent;
  const pendingSetupRef = useRef(pendingSetup);
  pendingSetupRef.current = pendingSetup;
  const requestSetupRef = useRef<((k: "brain" | "vision") => void) | null>(null);
  const convCtx = (): ConvContext => ({
    aliases: parseAliases(myNameRef.current),
    roster: rosterRef.current,
    callType: callTypeRef.current,
  });
  const isGroupCall = () =>
    callTypeRef.current === "group" ||
    (callTypeRef.current === "auto" && rosterRef.current.length >= 2);
  useMemoryRef.current = useMemory;
  modeRef.current = mode;
  providerRef.current = provider;
  cloudKeysRef.current = cloudKeys;
  cloudModelsRef.current = cloudModels;
  customBaseUrlRef.current = customBaseUrl;
  localModelRef.current = localModel;
  personaRef.current = persona;
  notesRef.current = notes;

  // The full system prompt the brain receives: generic persona + whatever
  // the notes folder provided. Stable per meeting, so caching stays intact.
  // A knowledge file can dictate HOW Robert answers for that meeting (e.g. an
  // interview file asking for bullet points under 300 characters) with a
  // "## Answer format" section. It overrides the persona's prose/length rules.
  const answerFormat = () => extractAnswerFormat(notesRef.current);
  const composeGrounding = () => {
    const fmt = answerFormat();
    return (
      DEFAULT_RULES + "\n\n" + personaRef.current +
      (notesRef.current ? NOTES_HEADER + notesRef.current : "") +
      (fmt
        ? `\n\n## ANSWER FORMAT (set by my meeting knowledge file; overrides every rule above about sentence count, length, and bullet points)\n${fmt.text}\n`
        : `\n\n## ANSWER FORMAT (default — shape every answer this way)\n${DEFAULT_ANSWER_FORMAT}\n`)
    );
  };
  // Anonymous usage/error telemetry to the operator's webhook (privacy-safe:
  // NEVER content — see src-tauri/src/telemetry.rs). Fire-and-forget.
  const track = useCallback((event: string, props: Record<string, unknown> = {}) => {
    invoke("robert_track", { event, props }).catch(() => {});
  }, []);
  const [telemetryOn, setTelemetryOn] = useState(false);
  useEffect(() => {
    invoke<boolean>("robert_telemetry_status").then(setTelemetryOn).catch(() => setTelemetryOn(false));
  }, []);
  const setTelemetry = useCallback((enabled: boolean) => {
    invoke("robert_telemetry_set", { enabled })
      .then(() => invoke<boolean>("robert_telemetry_status"))
      .then(setTelemetryOn)
      .catch(() => {});
  }, []);
  useEffect(() => { track("app_open", { provider: providerRef.current }); }, [track]);

  const reqIdRef = useRef(0);
  // A live suggestion is generating right now. Used to serialize generation:
  // never start a second one for the same turn while one is in flight (that is
  // what stacked 5 to 7 near-identical answers that flickered past mid-question).
  const suggestingRef = useRef(false);
  // Instant "thinking out loud" stall shown while the real answer generates.
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallActiveRef = useRef(false); // a stall (not a real answer) is on screen
  const lastAnswerRef = useRef(""); // last REAL answer shown, to revert a stall on WAIT
  const recentStallsRef = useRef<string[]>([]); // avoid reusing a stall phrase
  // Once a real answer is on the teleprompter it is LOCKED: nothing changes it
  // (not streaming, not a late-completing extra generation) until a NEW question
  // arrives. Cleared at the start of a new auto suggestion and on a manual Respond.
  const frozenRef = useRef(false);
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
  useEffect(() => localStorage.setItem("robert.notesFile", notesFile), [notesFile]);
  useEffect(
    () => localStorage.setItem("robert.recordMeetings", recordMeetings ? "1" : "0"),
    [recordMeetings]
  );
  useEffect(
    () => localStorage.setItem("robert.micCapture", micCapture ? "1" : "0"),
    [micCapture]
  );

  useEffect(() => localStorage.setItem(LS.localModel, localModel), [localModel]);
  /// Load _persona.md (create it from the default when missing; refresh it
  /// when it still equals an older default).
  const loadPersona = useCallback(async () => {
    const composedFromPicks = composeVoiceText(selectedVoicesRef.current);
    try {
      const content = await invoke<string | null>("robert_read_note", {
        notesFolder: notesFolderRef.current,
        name: PERSONA_FILE,
      });
      let voice: string;
      if (content && content.trim()) {
        voice = extractVoice(content) || composedFromPicks;
        // migrate a legacy full-persona file down to voice-only
        if (content.trim() !== voice) {
          await invoke("robert_write_note", {
            notesFolder: notesFolderRef.current, name: PERSONA_FILE, content: voice + "\n",
          });
        }
      } else {
        voice = selectedVoicesRef.current.length ? composedFromPicks : DEFAULT_VOICE;
        await invoke("robert_write_note", {
          notesFolder: notesFolderRef.current, name: PERSONA_FILE, content: voice + "\n",
        });
      }
      setPersona(voice);
      personaRef.current = voice;
      // "custom" = hand-edited away from both the default and the current picks
      setPersonaCustomized(voice.trim() !== DEFAULT_VOICE.trim() && voice.trim() !== composedFromPicks.trim());
    } catch {
      setPersona(DEFAULT_VOICE);
      personaRef.current = DEFAULT_VOICE;
    }
  }, []);

  // Reset the VOICE to Robert's default and clear the character picks.
  const resetPersona = useCallback(async () => {
    setSelectedVoices([]);
    await invoke("robert_write_note", {
      notesFolder: notesFolderRef.current,
      name: PERSONA_FILE,
      content: DEFAULT_VOICE + "\n",
    });
    await loadPersona();
  }, [loadPersona]);

  const openPersona = useCallback(async () => {
    const p = await invoke<string>("robert_note_path", {
      notesFolder: notesFolderRef.current,
      name: PERSONA_FILE,
    });
    await invoke("robert_open_path", { path: p });
  }, []);

  // Compose the picked characters into _persona.md's "## Voice" section, leaving
  // the rest of the persona intact. The voice is then part of every answer.
  const applyVoices = useCallback(async (ids: string[]) => {
    setSelectedVoices(ids);
    selectedVoicesRef.current = ids;
    try {
      // the voice file IS just the composed voice section (rules stay fixed in the app)
      await invoke("robert_write_note", {
        notesFolder: notesFolderRef.current, name: PERSONA_FILE, content: composeVoiceText(ids) + "\n",
      });
      await loadPersona();
    } catch (e: any) {
      setError(String(e));
    }
  }, [loadPersona]);

  const finishOnboarding = useCallback(() => {
    localStorage.setItem("robert.onboarded", "1");
    setOnboardingStep(null);
  }, []);
  useEffect(() => localStorage.setItem("robert.myName", myName), [myName]);

  useEffect(() => localStorage.setItem("robert.callType", callType), [callType]);
  useEffect(() => localStorage.setItem("robert.visionModel", visionModel), [visionModel]);
  useEffect(() => localStorage.setItem("robert.voices", JSON.stringify(selectedVoices)), [selectedVoices]);
  useEffect(() => localStorage.setItem(LS.provider, provider), [provider]);
  useEffect(() => localStorage.setItem(LS.notesFolder, notesFolder), [notesFolder]);

  // One routed call to the selected brain (local or cloud). Used by live
  // suggestions, the key test, and the post-meeting summary/merge.
  const brainCall = useCallback(
    async (system: string, user: string, maxTokens = 320): Promise<string> => {
      const prov = providerRef.current;
      if (prov === "local") {
        return await invoke<string>("robert_suggest_local", {
          model: localModelRef.current || LOCAL_BRAIN,
          system,
          user,
          maxTokens,
        });
      }
      const meta = CLOUD_PROVIDERS.find((p) => p.id === prov);
      const key = (cloudKeysRef.current[prov] || "").trim();
      if (!key) throw new Error(`Add your ${meta?.label ?? prov} API key in settings.`);
      const mdl = (cloudModelsRef.current[prov] || meta?.defaultModel || "").trim();
      if (prov === "anthropic") {
        return await invoke<string>("robert_suggest_anthropic", {
          apiKey: key,
          model: mdl || "claude-opus-5",
          system,
          user,
          maxTokens,
        });
      }
      const baseUrl = prov === "custom" ? customBaseUrlRef.current.trim() : meta?.baseUrl || "";
      if (prov === "custom" && !baseUrl)
        throw new Error("Set the custom provider's base URL in settings.");
      return await invoke<string>("robert_suggest", {
        apiKey: key,
        model: mdl,
        system,
        user,
        baseUrl,
        maxTokens,
      });
    },
    []
  );

  // Streaming variant used ONLY for the primary answer generation so a long
  // reply appears progressively. Local brain streams token-by-token via the
  // "robert://token" event; cloud/anthropic/custom fall back to one onToken
  // with the full result (they are fast enough). Nothing else about suggest()
  // changes: the final humanize, cap, store, and monotonic-display logic runs
  // on the returned full string exactly as before.
  const brainCallStream = useCallback(
    async (
      system: string,
      user: string,
      maxTokens: number,
      reqId: number,
      onToken: (full: string) => void
    ): Promise<string> => {
      if (providerRef.current === "local") {
        let un: undefined | (() => void);
        try {
          un = await listen<RobertToken>("robert://token", (e) => {
            if (e.payload && e.payload.id === reqId) onToken(e.payload.text || "");
          });
          return await invoke<string>("robert_suggest_local_stream", {
            reqId,
            model: localModelRef.current || LOCAL_BRAIN,
            system,
            user,
            maxTokens,
          });
        } finally {
          if (un) un();
        }
      }
      const full = await brainCall(system, user, maxTokens);
      onToken(full);
      return full;
    },
    [brainCall]
  );

  // Append one event to the current meeting's transcript log (if recording).
  const logEvent = useCallback((obj: Record<string, unknown>) => {
    const dir = meetingDirRef.current;
    if (!dir) return;
    const t = new Date().toTimeString().slice(0, 8);
    invoke("robert_meeting_append", {
      notesFolder: notesFolderRef.current,
      dir,
      line: JSON.stringify({ t, ...obj }),
    }).catch(() => {});
  }, []);

  const suggest = useCallback(async (turnText: string, force = false) => {
    // Auto adopts interview pacing when the selected knowledge is an interview
    // file (title "Interview knowledge: ..."), so there is no mode to remember.
    const interviewFile = /^#\s*interview knowledge/im.test(notesRef.current.slice(0, 400));
    const type: RobertMode | "interview" =
      modeRef.current === "auto" && interviewFile ? "interview" : modeRef.current; // conversation type
    const id = ++reqIdRef.current;
    // keep the current answer on screen until a new one is ready (and on WAIT)
    suggestingRef.current = true;
    // A new AUTO question unlocks the teleprompter so this answer can take over;
    // a manual Respond (force) already cleared the lock in respondNow.
    if (!force) frozenRef.current = false;
    setSuggesting(true);
    setError(null);

    // Every live suggestion = the selected brain with the composed grounding.
    const fmt = answerFormat();
    // The cap for THIS question: narrative questions ("walk me through your
    // employment history") get the format's larger cap; the rest the default.
    const askedText = (segmentRef.current.join(" ") + " " + partialRef.current + " " + turnText).trim();
    const cap = capFor(fmt, askedText);
    const narrative = !!fmt && isNarrativeQuestion(askedText);
    // Always cap the live answer, even when the selected knowledge file names no
    // character limit. Uncapped answers ran 550 to 900 chars and buried the
    // point; default to a tight ceiling (a lead line plus a couple of short
    // bullets), with more room only for narrative "walk me through" questions.
    const effectiveCap = cap ?? ((isNarrativeQuestion(askedText) || isDepthQuestion(askedText)) ? 800 : 380);
    // a character cap means fewer tokens: ~3.5 chars per token plus slack
    const budget = Math.min(480, Math.ceil(effectiveCap / 3.5) + 60);
    const askBrain = (user: string) => brainCall(composeGrounding(), user, budget);

    // Instant "thinking out loud" stall: if the real answer has not begun
    // streaming within ~380ms, show a short, varied lead-in the user can say
    // aloud to buy time. Fast (cloud) answers beat the timer and skip it; slow
    // (local) answers get covered. Replaced when real content streams in (reveal)
    // and reverted if the brain says WAIT (finally). Skipped for greetings, whose
    // answers are already instant.
    if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null; }
    stallActiveRef.current = false;
    const isGreetingTurn =
      askedText.length < 16 ||
      /\b(hi|hey|hello|how are you|nice to meet|good (morning|afternoon|evening))\b/i.test(askedText);
    if (!isGreetingTurn) {
      const isNarr = isNarrativeQuestion(askedText);
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        if (id !== reqIdRef.current || id < displayedIdRef.current || frozenRef.current) return;
        const pool = isNarr ? STALL_NARRATIVE : STALL_DIRECT;
        const recent = recentStallsRef.current;
        const fresh = pool.filter((p) => !recent.includes(p));
        const choose = fresh.length ? fresh : pool;
        const phrase = choose[Math.floor(Math.random() * choose.length)];
        recentStallsRef.current = [phrase, ...recent].slice(0, 4);
        setSuggestion(phrase);
        stallActiveRef.current = true;
      }, 380);
    }
    // Research: keyless — DuckDuckGo snippets synthesized by the active brain.
    const research = async (query: string): Promise<string> => {
      try {
        const snippets = await invoke<string>("robert_research_free", { query });
        return (
          await askBrain(
            `Web search results for "${query}":\n${snippets}\n\nUsing ONLY these results, give me one short, natural, speakable line answering it. If the results don't answer it, give me the honest line I can say instead.`
          )
        ).trim();
      } catch {
        // web search unavailable (rate-limited / offline): degrade to the
        // brain's general knowledge, honestly flagged
        return (
          await askBrain(
            `I can't reach the web right now. From general knowledge, give me one short, speakable line addressing: ${query} — phrased so I'm not claiming certainty (e.g. "as far as I know", "I'll confirm the exact figure").`
          )
        ).trim();
      }
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
      // Per-turn retrieval: the paragraphs across ALL notes that best match
      // what they are asking, so the answer can dig into the references
      // instead of skimming one file. Goes in the user turn (system stays
      // stable for caching). Fast local scan; skipped for tiny fragments.
      let relevant = "";
      const q = (segment || turnText).slice(-500);
      if (q.split(/\s+/).length >= 3) {
        try {
          relevant = await invoke<string>("robert_retrieve_notes", {
            notesFolder: notesFolderRef.current,
            query: q,
            // Wider budget so the exact bridge/metric AND some varied backup
            // material are both in front of the model (interview answers lean on
            // specifics + variety); the server diversifies across sections.
            maxChars: 2200,
            // the note selected for this meeting (or the brief) ranks first
            prefer: notesFileRef.current || "robert-brief.md",
          });
        } catch {
          relevant = "";
        }
      }
      const recentLines = mySuggestionsRef.current.slice(-6);
      // conversation read: auto mode adapts; explicit modes keep their rule
      const read = readConversation(historyRef.current, segment, convCtx());
      const readHint =
        modeRef.current === "auto" ? `My read of the conversation: ${read.hint}\n` : "";
      // Group call: several people share the "Them" lines; say who I am, who
      // is in the room, and who this line is for, so Robert only speaks for me.
      const aliases = parseAliases(myNameRef.current);
      const who = read.group?.addressee;
      const groupBlock = isGroupCall()
        ? `GROUP CALL: the "Them" lines mix several people (the transcript does not separate speakers). ` +
          (aliases.length ? `I am ${myNameRef.current.split(/[,;/]/)[0].trim()}. ` : "") +
          (rosterRef.current.length ? `People heard so far: ${rosterRef.current.join(", ")}. ` : "") +
          `This line is addressed to: ${
            who?.to === "me" ? "me" : who?.to === "other" ? who.name : who?.to === "group" ? "the whole room" : "no one in particular"
          }. Only ever speak for me; never answer on a colleague's behalf.\n`
        : aliases.length
        ? `My name is ${myNameRef.current.split(/[,;/]/)[0].trim()}.\n`
        : "";
      const prompt =
        (hist ? `Conversation so far (Them = the other side, Me = me):\n${hist}\n\n` : "") +
        (myLastLineRef.current
          ? `The last thing I said out loud: "${myLastLineRef.current}"\n\n`
          : "") +
        `The other side is saying this now. Treat it as ONE message and respond to the WHOLE thing, even if it is several sentences:\n${segment || turnText}\n\n` +
        (relevant
          ? `RELEVANT NOTES (pulled from my files for THIS question). Answer FROM these: name the specific experience, project, or JD-requirement bridge that maps to exactly what they asked, and back it with the figure and the name/client. Say numbers as a NATURAL ESTIMATE — "about", "around", "roughly", a round figure — never a suspiciously exact one; a real person estimates their own results, and it sounds far more authentic. A generic answer that could come from anyone — one that skips the specifics — is wrong.\n${relevant}\n\n`
          : "") +
        (recentLines.length
          ? `Answers I ALREADY gave earlier this session. Do NOT repeat their wording, and do NOT reuse the same project, client, example, story, metric, or opening — my experience is BROAD and my notes hold many facets, so each answer must draw on a DIFFERENT one and show range. Circling the same one or two stories makes me look one-dimensional, which is a red flag:\n${recentLines.map((l) => `- ${l}`).join("\n")}\n\n`
          : "") +
        groupBlock +
        readHint +
        `${typeRule}\n` +
        // Regular meetings (group + 1:1) only, never interviews: project command
        // of my work + reliable, low-maintenance delivery, grounded in my notes.
        (type !== "interview" ? MEETING_PRESENCE + "\n" : "") +
        (fmt
          ? `- ANSWER FORMAT (non-negotiable, overrides the sentence rules below): ${fmt.text.replace(/\s+/g, " ")}\n` +
            (narrative && cap
              ? `- This is a NARRATIVE question (a history, a walkthrough, an example): use the narrative allowance, up to ${cap} characters, 4 to 6 bullets in time order, each carrying one concrete number or name. Still open with the one-sentence explainer.\n`
              : "")
          : "") +
        `- GROUND IT IN ME: when my notes show real experience with what they asked, lead with THAT — the specific project, client, and number that maps to the question (the bridge).\n` +
        `- IF I HAVE NO DIRECT EXPERIENCE on the topic: never say so, and never claim a false personal history ("I built/ran X" when I didn't). Sound knowledgeable — real command of how the thing works and the right approach — then bridge to my closest real experience ("I've worked mostly with X, closely related — same principle"). Draw on the illustrative scenarios in my notes for shape and depth.\n` +
        `- IF THEY ASK FOR A BREAKDOWN or walk-through (step by step, "how did you do it", the technical detail, the process, the architecture): go DEEP — the concrete steps, components, tools, and the decisions and trade-offs behind them, with real specificity. On my real work, use the real detail. On a gap topic, frame it as how it works / how I'd approach it rather than a claimed history, but still give the full, credible breakdown a strong candidate would — never a thin "I'd look into it".\n` +
        `- RAPPORT / OPENING MOMENT: if this is a greeting, small talk, warm-up, or the other side just setting up (not yet a substantive question), give me a short, warm, natural HUMAN line to build rapport — one or two easy sentences a real person would say, no pitch and no specifics. Save the projects and numbers for the real questions.\n` +
        `- SHOW RANGE: my background is broad. Pick the facet of my experience that best fits THIS question and that I have NOT already leaned on this session, so across the call I come across as multi-dimensional, not stuck on one story.\n` +
        `- They have already paused by the time you see this. Reply EXACTLY WAIT only if they are clearly mid-thought, or the text sounds like my own voice echoed back. When in doubt, give me a line.\n` +
        `- If a good answer needs current or external info you are not sure of, reply EXACTLY: NEEDS_RESEARCH: <focused web query>\n` +
        `- Otherwise give me the answer to say, in my Answer format above: open with a one-line intro that frames the point in my own words, then the complete answer using the concrete specifics (numbers, names, facts) from my notes. Natural and speakable, as if I thought of it. If a claim seems off, make it a polite probing question. No labels, just the answer.`;
      const asked = segment || turnText; // what this request is answering
      // Stream the primary answer to the overlay: reveal progressively once we
      // can rule out a WAIT / NEEDS_RESEARCH control reply, so a long answer
      // shows its first words fast instead of after the whole generation.
      const reveal = (buf: string) => {
        const t = buf.trimStart();
        if (t.length < 10 && !t.includes("\n")) return; // not enough to judge yet
        if (/^\s*(WAIT\b|NEEDS_RESEARCH\s*:)/i.test(t)) return; // control reply, keep thinking
        if (id < displayedIdRef.current || frozenRef.current) return; // a newer answer owns it, or the shown answer is locked
        // real content is here: drop the stall and let the answer take over
        if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null; }
        stallActiveRef.current = false;
        setSuggestion(t);
      };
      let first = (
        await brainCallStream(composeGrounding(), prompt, budget, id, reveal)
      ).trim();
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
          out = await research(q);
        }
      } else {
        route = "suggest";
        out = first;
      }
      let line = out.trim();
      if (!wait && line) {
        // Strip AI tells deterministically; if heavy patterns survive, ask
        // for ONE rewrite in plain spoken words (rare, cheap).
        let h = humanizeLine(line);
        // The rewrite is a SECOND full generation. On a local brain that doubles
        // the wait for a live answer, so skip it there (the deterministic strip
        // already ran); cloud brains are fast enough to afford the polish.
        if (h.needsRewrite && providerRef.current !== "local") {
          try {
            const re = await askBrain(
              `Rewrite this exactly as I'd say it out loud to a colleague. Same facts and numbers, plain words, no opener, no corporate language, no "not just X but Y":\n${h.text}`
            );
            h = humanizeLine(re);
          } catch {
            /* keep the filtered line */
          }
        }
        line = capToFormat(normalizeBullets(h.text), effectiveCap);
      }
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
        setAnswersGiven((n) => n + 1);
        logEvent({ who: "robert", text: line, route, asked: asked.slice(-200) });
        // Monotonic display: newest finished answer takes the screen now.
        if (id > displayedIdRef.current && !frozenRef.current) {
          displayedIdRef.current = id;
          if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null; }
          stallActiveRef.current = false;
          lastAnswerRef.current = line;
          setSuggestion(line);
          setLastRoute(route);
          // Lock it: this answer stays on the teleprompter until a NEW question.
          // A later-completing generation (e.g. from an extra Respond click) will
          // not overwrite it.
          frozenRef.current = true;
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
      track("error", { where: "suggest", msg: String(e).slice(0, 200) });
    } finally {
      if (id === reqIdRef.current) {
        setSuggesting(false);
        suggestingRef.current = false;
        if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null; }
        if (stallActiveRef.current) {
          // a stall was showing but no real answer replaced it (WAIT / aside):
          // revert to the last real answer so no filler is left hanging.
          setSuggestion(lastAnswerRef.current);
          stallActiveRef.current = false;
        }
      }
    }
  }, [brainCall, logEvent]);

  // Manual trigger: force a response to the last completed turn (human-in-the-loop).
  const respondNow = useCallback(() => {
    // One answer at a time: while a suggestion is still generating, ignore extra
    // Respond clicks so they do not stack several slow generations that each
    // overwrite the last. The one in flight is already coming.
    if (suggestingRef.current) return;
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
    // A deliberate Respond may replace a shown answer (the user asked for it).
    frozenRef.current = false;
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
        // One answer at a time. If a suggestion is still generating, do NOT start
        // a second for the same turn (that stacked 5 to 7 near-identical answers).
        // Wait it out and retry once it settles; the segment is cleared after it
        // answers, so this only re-fires on genuinely new speech.
        if (suggestingRef.current) {
          armHold(turnText, 400);
          return;
        }
        suggest(turnText);
      }, holdMs);
    };
    const unEvent = listen<string>("robert://event", (e) => {
      const ev = parseRobertEvent(e.payload);
      if (!ev) return;
      switch (ev.type) {
        case "status":
          setStatus(ev.stage);
          if (ev.stage === "ready") setError(null);
          break;
        case "partial": {
          const p = ev.text || "";
          // My own live speech from the mic (--mic stream). Keep "the last thing
          // I said" fresh for grounding, but NEVER treat it as the other party's
          // floor (no setPartial/clearHold) and never trigger a suggestion. The
          // me-final records it; me-partials stay ephemeral like them-partials.
          if (ev.who === "me") {
            if (p.trim()) myLastLineRef.current = p.trim();
            break;
          }
          setPartial(p);
          partialRef.current = p;
          // speech resumed: the floor was NOT yielded, keep accumulating
          if (p.trim()) clearHold();
          break;
        }
        case "final": {
          const t = (ev.text || "").trim();
          // My own completed turn from the mic (--mic stream). Record it as my
          // side of the dialogue and stand by: my talking is never a question to
          // answer, so it must NOT trigger a suggestion. Do not touch the other
          // party's live partial. Everything without who:"me" keeps its exact
          // current path below.
          if (ev.who === "me") {
            if (t) {
              myLastLineRef.current = t;
              historyRef.current = [
                ...historyRef.current,
                { who: "me" as const, text: t },
              ].slice(-12);
              setLastRoute("delivered");
              logEvent({ who: "me", text: t, mic: true });
            }
            break;
          }
          setPartial("");
          partialRef.current = "";
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
            logEvent({ who: "me", text: t, delivered: true });
            // line delivered: collapse the stacked extras so the window
            // retracts back toward its default size
            setAnswers((prev) => (prev.length > 1 ? prev.slice(0, 1) : prev));
            break;
          }
          segmentRef.current = [...segmentRef.current, t];
          setLastTurn(t);
          setTurnsHeard((n) => n + 1);
          logEvent({ who: "them", text: t });
          // Floor-yield window: answer once they actually stop, not per
          // sentence. Auto adapts to the conversation read; explicit modes
          // have fixed windows (interview answers fast, listening holds).
          const m = modeRef.current;
          let holdMs: number;
          if (m === "interview") holdMs = 200;
          else if (m === "listening") holdMs = 1000;
          else if (m === "discussion") holdMs = 500;
          else {
            const read = readConversation(
              historyRef.current,
              segmentRef.current.join(" "),
              convCtx()
            );
            setConvKind(read.kind);
            holdMs = read.holdMs;
            // roster: colleagues heard this call (for group detection + summary)
            const names = read.group?.names ?? [];
            if (names.length) {
              const merged = [...rosterRef.current];
              for (const n of names) if (!merged.includes(n)) merged.push(n);
              if (merged.length !== rosterRef.current.length) {
                rosterRef.current = merged;
                setParticipants(merged);
              }
            }
            const who = read.group?.addressee;
            setAddressedTo(
              who?.to === "me" ? "you" : who?.to === "other" ? who.name || "" : who?.to === "group" ? "the room" : ""
            );
            if (read.silent) {
              // Addressed to a named colleague: listen, do not answer. Close
              // the segment into history so the exchange stays in context
              // for "anything to add?" a moment later.
              clearHold();
              const closed = segmentRef.current.join(" ").trim();
              if (closed) {
                historyRef.current = [
                  ...historyRef.current,
                  { who: "them" as const, text: closed },
                ].slice(-12);
              }
              segmentRef.current = [];
              partialRef.current = "";
              setLastRoute("aside");
              break;
            }
          }
          armHold(t, holdMs);
          break;
        }
        case "error":
          setError(ev.message || "Engine error.");
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
  }, [suggest, logEvent]);

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

  // Fire one tiny real request at the selected brain so the user gets a
  // clear "key accepted / here's the exact error" signal before a meeting.
  const testBrain = useCallback(async () => {
    setBrainTest({ status: "testing", detail: "" });
    try {
      const out = await brainCall("Reply with exactly: OK", "Say OK", 16);
      setBrainTest({ status: "ok", detail: out.slice(0, 60) });
    } catch (e: any) {
      setBrainTest({ status: "fail", detail: String(e).slice(0, 220) });
    }
  }, [brainCall]);

  // A different brain selection invalidates the last test result.
  useEffect(() => {
    setBrainTest({ status: "idle", detail: "" });
  }, [provider]);

  const refreshMeetings = useCallback(async () => {
    try {
      setMeetings(
        await invoke<MeetingInfo[]>("robert_list_meetings", {
          notesFolder: notesFolderRef.current,
        })
      );
    } catch {
      setMeetings([]);
    }
  }, []);
  useEffect(() => {
    refreshMeetings();
  }, [refreshMeetings, notesFolder]);

  const deleteMeeting = useCallback(
    async (dir: string) => {
      try {
        await invoke("robert_delete_meeting", { notesFolder: notesFolderRef.current, dir });
      } catch (e: any) {
        setError(String(e));
      }
      refreshMeetings();
    },
    [refreshMeetings]
  );
  const openPath = useCallback((path: string) => {
    invoke("robert_open_path", { path }).catch(() => {});
  }, []);

  // After Stop: render the transcript, write the takeaways, merge them into
  // memory. Runs in the background; the UI shows postMeeting status.
  const finishMeeting = useCallback(
    async (dir: string) => {
      const notesFolder = notesFolderRef.current;
      const strip = (t: string) =>
        t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
      try {
        setPostMeeting("saving transcript…");
        const [transcript, turns] = await invoke<[string, number]>("robert_meeting_finish", {
          notesFolder,
          dir,
        });
        if (turns < 2) {
          // Nothing worth keeping: a header-only / near-empty session where
          // capture produced no real turns. Remove the empty folder so the
          // meeting picker and memory stay clean instead of piling up dead
          // dirs (these were the bulk of the "orphaned" meetings on disk).
          try {
            await invoke("robert_delete_meeting", { notesFolder, dir });
          } catch {}
          setPostMeeting("");
          refreshMeetings();
          return;
        }
        setPostMeeting("writing takeaways…");
        const summary = strip(await brainCall(SUMMARY_SYSTEM, transcript.slice(-60000), 1600));
        await invoke("robert_meeting_write", { notesFolder, dir, name: "summary.md", content: summary });
        // The takeaways also land as a normal top-level note, so they are a
        // first-class option in the Meeting knowledge picker and in Auto mode.
        const meetingIdForNote = dir.split(/[\\/]/).pop() || "meeting";
        await invoke("robert_write_note", {
          notesFolder,
          name: `${meetingIdForNote}_takeaways.md`,
          content: summary,
        }).catch(() => {});
        setPostMeeting("updating memory…");
        const meetingId = dir.split(/[\\/]/).pop() || dir;
        const mem = await invoke<Record<string, string>>("robert_read_memory", { notesFolder });
        for (const [name, rules] of Object.entries(MEMORY_RULES)) {
          const cur = (mem[name] || "").trim();
          const updated = strip(
            await brainCall(
              MERGE_SYSTEM + "\n\n" + rules,
              `MEETING ID: ${meetingId}\n\nCURRENT FILE (${name}):\n${cur || "(empty)"}\n\nNEW MEETING SUMMARY:\n${summary}`,
              1600
            )
          );
          if (updated && updated !== "NOOP" && updated.length > 10) {
            await invoke("robert_write_memory", { notesFolder, name, content: updated });
          }
        }
      } catch (e: any) {
        setError("Meeting memory: " + String(e).slice(0, 200));
      } finally {
        setPostMeeting("");
        refreshMeetings();
        reloadGrounding();
      }
    },
    [brainCall, refreshMeetings]
  );

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
      rosterRef.current = [];
      setParticipants([]);
      setAddressedTo("");
      setTurnsHeard(0);
      setAnswersGiven(0);
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
          silenceMs: 900,
          // Windows: which output device's loopback to capture (null = default).
          outputDevice: outputDeviceRef.current || null,
          // macOS: also capture MY microphone as a second stream (opt-in). When
          // false the engine runs system-audio only, exactly as before.
          mic: micCaptureRef.current,
        });
        setRunning(true);
        track("meeting_start", { provider: providerRef.current, mode: modeRef.current });
        // Meeting Memory: open the transcript log for this session.
        meetingDirRef.current = "";
        if (recordMeetingsRef.current) {
          const now = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const started = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
          try {
            meetingDirRef.current = await invoke<string>("robert_meeting_begin", {
              notesFolder: notesFolderRef.current,
              target: opts?.bundle ?? target,
              mode: modeRef.current,
              brain: providerRef.current,
              started,
              iso: now.toISOString(),
            });
          } catch {
            meetingDirRef.current = "";
          }
        }
        // Prime the brain so turn one is as fast as turn ten. Fire and forget.
        // Local: loads the model + evaluates the grounding KV prefix in Ollama.
        // DeepSeek: warms its remote context cache (other clouds have none).
        if (providerRef.current === "local") {
          invoke("robert_prewarm_local", {
            model: localModelRef.current || LOCAL_BRAIN,
            system: composeGrounding(),
          }).catch(() => {});
        } else if (
          providerRef.current === "deepseek" &&
          (cloudKeysRef.current.deepseek || "").trim()
        ) {
          invoke("robert_prewarm_cache", {
            apiKey: cloudKeysRef.current.deepseek.trim(),
            model: cloudModelsRef.current.deepseek || "deepseek-chat",
            system: composeGrounding(),
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
    track("meeting_end", { turns: turnsHeardRef.current, answers: answersGivenRef.current });
    const dir = meetingDirRef.current;
    meetingDirRef.current = "";
    if (dir) finishMeeting(dir);
  }, [finishMeeting, track]);

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
    await loadPersona();
    try {
      // refresh the selectable file list alongside the content
      invoke<string[]>("robert_list_notes", {
        notesFolder: notesFolderRef.current,
      })
        .then(setNotesList)
        .catch(() => setNotesList([]));
      const g = await invoke<{ source: string; content: string }>(
        "robert_load_grounding",
        {
          notesFolder: notesFolderRef.current,
          notesFile: notesFileRef.current,
          useMemory: useMemoryRef.current,
        }
      );
      setNotes(g.content);
      // update the ref immediately so a prewarm right after load (before the
      // re-render commits) caches the real grounding prefix, not a stale one
      notesRef.current = g.content;
      setGroundingSource(g.source);
      setError(null);
      // If the user never set their name, derive it from profile.md ("# Profile:
      // <full name>"). Without a name, the group/addressing layer can NEVER mark a
      // line as "to me", so auto mode returns WAIT every time and never speaks.
      // Deriving it (first name + full name as aliases) makes auto-respond work
      // with zero setup. Only fills an empty field; a user-set name always wins.
      if (!myNameRef.current.trim()) {
        try {
          const prof = await invoke<string | null>("robert_find_profile", {
            notesFolder: notesFolderRef.current,
          });
          const m = prof && prof.match(/^#\s*Profile:\s*(.+)$/im);
          if (m) {
            const full = m[1].trim().replace(/\s+/g, " ").slice(0, 60);
            const first = full.split(" ")[0];
            const derived =
              first && first.toLowerCase() !== full.toLowerCase() ? `${first}, ${full}` : full;
            if (derived) {
              myNameRef.current = derived;
              setMyName(derived);
            }
          }
        } catch {
          /* best effort — no profile yet is fine */
        }
      }
    } catch (e: any) {
      // keep the default persona grounding if nothing is on disk
      setError(String(e));
    }
  }, [loadPersona]);

  useEffect(() => {
    reloadGrounding();
  }, [reloadGrounding]);

  // Decide whether to onboard: never on a machine that is already set up.
  useEffect(() => {
    if (localStorage.getItem("robert.onboarded") === "1") return;
    (async () => {
      let configured = false;
      try {
        configured = await invoke<boolean>("robert_is_configured", {
          notesFolder: notesFolderRef.current,
        });
      } catch {
        configured = false;
      }
      // installed local model also counts as "already set up"
      if (!configured) {
        try {
          const st = await invoke<{ has_model: boolean }>("robert_local_status", {
            model: localModelRef.current || LOCAL_BRAIN,
          });
          if (st?.has_model) configured = true;
        } catch {
          /* ignore */
        }
      }
      if (configured) {
        localStorage.setItem("robert.onboarded", "1");
      } else {
        setOnboardingStep("resume");
      }
    })();
  }, []);

  // ── Knowledge inbox ──────────────────────────────────────────────────────
  const refreshInbox = useCallback(async () => {
    try {
      const files = await invoke<string[]>("robert_list_inbox", {
        notesFolder: notesFolderRef.current,
      });
      setInbox(files);
      return files;
    } catch {
      setInbox([]);
      return [] as string[];
    }
  }, []);

  const convertingRef = useRef(false);

  /// Rewrite one inbox file into Robert's spec with the active brain, save it
  /// as a note, park the source in sources/, and select it.
  const convertFile = useCallback(
    async (file: string, opts: { fromSources?: boolean; replaces?: string } = {}) => {
      if (convertingRef.current) return;
      convertingRef.current = true;
      setConverting(file);
      let madeProfile = false;
      let brainDown = false;
      try {
        setConvertStatus(`Reading ${file}…`);
        const ex = await invoke<{ file: string; kind: string; chars: number; truncated: boolean; text: string }>(
          "robert_extract_text",
          { notesFolder: notesFolderRef.current, file, fromSources: !!opts.fromSources }
        );
        const profile = await invoke<string | null>("robert_find_profile", {
          notesFolder: notesFolderRef.current,
        });
        const brainName = providerRef.current === "local" ? `local ${localModelRef.current}` : providerRef.current;
        setConvertStatus(
          `Rewriting ${file} into Robert's format with the ${brainName} brain${
            providerRef.current === "local" ? " (up to a few minutes on a local brain — longer on a low-RAM PC)" : ""
          }…`
        );
        const user =
          `SOURCE FILE: ${ex.file} (${ex.kind}${ex.truncated ? ", truncated to the first 60,000 characters" : ""})\n\n` +
          `SOURCE:\n${ex.text}\n\n` +
          (profile ? `PROFILE (my experience, use it to map requirements):\n${profile}\n\n` : "PROFILE: none given.\n\n") +
          `Write the Markdown file now.`;
        let out: string;
        try {
          out = (await brainCall(CONVERT_SYSTEM, user, 4200)).trim();
          out = out.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
          if (!out) throw new Error("empty response from the brain");
        } catch {
          // The brain was unreachable, too slow, or timed out. NEVER throw away
          // the text we already extracted deterministically in Rust — write it as
          // a usable file so the résumé/document is captured (grounding and
          // retrieval work fine on raw text), and the polished rewrite can run
          // later once the brain is healthy. This is what turns a brain outage
          // from a total dead end into a minor "we'll tidy it up later".
          brainDown = true;
          const looksResume = /resume|cv|curriculum|profile/i.test(file);
          out =
            (looksResume && !profile
              ? `# Profile\n\n_Captured from ${file}. Robert will rewrite this into its format once the local brain is ready (or switch to a cloud brain in settings)._\n\n`
              : `# ${file.replace(/\.[^.]+$/, "")}\n\n_Captured from ${file}. Robert will rewrite this into its format once the brain is ready._\n\n`) +
            ex.text.trim();
        }
        if (!out.startsWith("#")) out = `# ${file.replace(/\.[^.]+$/, "")}\n\n${out}`;
        const title = (out.split("\n")[0] || "").replace(/^#+\s*/, "");
        const slug = title
          .toLowerCase()
          .replace(/^(interview knowledge|brief)\s*:\s*/, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || file.replace(/\.[^.]+$/, "").toLowerCase();
        const isProfile = /^# profile/i.test(out);
        // make sure the Sources section names both files even if the model
        // dropped it
        if (!isProfile && !/^## Sources/m.test(out)) {
          out +=
            `\n\n## Sources\n- Source: ${file}\n- Profile: ${
              profile ? "profile.md" : "none (upload your résumé and this file will be rebuilt against it)"
            }`;
        }
        const fileName = isProfile
          ? "profile.md"
          : opts.replaces || `${/^# brief/i.test(out) ? "robert-brief_" : "robert-knowledge_"}${slug}.md`;
        const name = await invoke<string>("robert_write_note", {
          notesFolder: notesFolderRef.current,
          name: fileName,
          content: out + "\n",
        });
        if (!opts.fromSources) {
          // Best effort: the knowledge file is already saved above, so a hiccup
          // moving the original into sources/ must NEVER report the whole
          // conversion as failed (this was the "source not found" error).
          try {
            await invoke("robert_archive_source", { notesFolder: notesFolderRef.current, file });
          } catch (e) {
            console.warn("archive source failed (non-fatal):", e);
          }
        }
        if (isProfile) {
          madeProfile = true;
          setConvertStatus(
            brainDown
              ? `Saved your résumé as profile.md (raw text — the brain wasn't ready to polish it). It already works for meetings; set up a brain, then re-add the résumé to refine it.`
              : `Saved your résumé as profile.md. Every job description you add is now mapped against it.`
          );
        } else {
          setNotesFile(name);
          notesFileRef.current = name;
          setConvertStatus(
            brainDown
              ? `Saved ${name} as raw text (the brain wasn't ready to polish it) and selected it as the meeting knowledge. Re-add it later to refine.`
              : opts.replaces
              ? `Rebuilt ${name} against your profile.`
              : `Added ${name} and selected it as the meeting knowledge${
                  profile ? " (mapped against profile.md)" : ""
                }. Source moved to sources/.`
          );
        }
        await reloadGrounding();
      } catch (e: any) {
        setConvertStatus(`Could not convert ${file}: ${String(e)}`);
      } finally {
        convertingRef.current = false;
        setConverting("");
        refreshInbox();
      }
      // A new profile: rebuild every knowledge file that was converted
      // without one, so each of them references the résumé too. Skip when the
      // brain is down — there is nothing to rewrite with, and each attempt would
      // just wait out the timeout again.
      if (madeProfile && !brainDown) {
        try {
          const stale = await invoke<[string, string][]>("robert_list_unprofiled", {
            notesFolder: notesFolderRef.current,
          });
          for (const [note, src] of stale) {
            setConvertStatus(`Rebuilding ${note} against your profile…`);
            await convertFileRef.current(src, { fromSources: true, replaces: note });
          }
        } catch {
          /* best effort */
        }
      }
    },
    [brainCall, reloadGrounding, refreshInbox]
  );
  const convertFileRef = useRef(convertFile);
  convertFileRef.current = convertFile;

  // auto-convert: whenever the inbox has files and nothing is running
  useEffect(() => {
    if (!autoConvert || convertingRef.current || inbox.length === 0) return;
    convertFile(inbox[0]);
  }, [inbox, autoConvert, convertFile]);

  useEffect(() => {
    refreshInbox();
  }, [refreshInbox, notesFolder]);

  /// Files chosen with the in-app picker (bytes travel to Rust as base64).
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const f of Array.from(files)) {
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          }
          const name = await invoke<string>("robert_import_bytes", {
            notesFolder: notesFolderRef.current,
            name: f.name,
            dataBase64: btoa(bin),
          });
          if (name.toLowerCase().endsWith(".md")) {
            setConvertStatus(`Added ${name}.`);
            await reloadGrounding();
          } else {
            setConvertStatus(`Received ${name}.`);
          }
        } catch (e: any) {
          setConvertStatus(`Could not add ${f.name}: ${String(e)}`);
        }
      }
      refreshInbox();
    },
    [reloadGrounding, refreshInbox]
  );

  // Drag-and-drop onto the window: copy into the notes folder, then the inbox
  // (and auto-convert) takes over.
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        if (e.payload.type !== "drop") return;
        for (const path of e.payload.paths) {
          try {
            const name = await invoke<string>("robert_import_file", {
              notesFolder: notesFolderRef.current,
              path,
            });
            setConvertStatus(name.toLowerCase().endsWith(".md") ? `Added ${name}.` : `Received ${name}.`);
            if (name.toLowerCase().endsWith(".md")) await reloadGrounding();
          } catch (err: any) {
            setConvertStatus(`Could not add ${path}: ${String(err)}`);
          }
        }
        refreshInbox();
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => {
      if (un) un();
    };
  }, [reloadGrounding, refreshInbox]);

  // ── Local brain status + one-click setup ─────────────────────────────────
  const refreshLocalStatus = useCallback(async () => {
    try {
      const st = await invoke<{ installed: boolean; running: boolean; models: string[]; has_model: boolean }>(
        "robert_local_status",
        { model: localModelRef.current }
      );
      setLocalStatus(st);
      return st;
    } catch {
      setLocalStatus(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (provider === "local") refreshLocalStatus();
  }, [provider, localModel, refreshLocalStatus]);

  useEffect(() => {
    const un = listen<{ stage: string; status: string; completed: number; total: number }>(
      "robert://local",
      (e) => {
        setLocalSetup(e.payload);
        if (e.payload.stage === "done" || e.payload.stage === "error") {
          refreshLocalStatus();
        }
      }
    );
    return () => {
      un.then((f) => f());
    };
  }, [refreshLocalStatus]);

  const cancelLocalSetup = useCallback(async () => {
    try {
      await invoke("robert_local_cancel");
    } catch {
      /* ignore */
    }
  }, []);

  // First launch: pick the model this machine can run (gemma4:12b at every tier;
  // below ~9 GB it runs but is slow and a cloud brain is far better), once,
  // unless the user already chose one. Always record RAM so the settings panel
  // can warn a low-RAM PC even after the one-time recommendation has run.
  useEffect(() => {
    invoke<{ ram_gb: number; model: string; why: string }>("robert_local_recommend")
      .then((rec) => {
        if (rec.ram_gb > 0) setLocalRamGb(rec.ram_gb);
        // v2: re-apply once on update so existing Windows installs pick up the
        // platform default (4B), while the Mac's recommendation stays 12b (no-op).
        if (localStorage.getItem("robert.localRecommended.v2") === "1") return;
        localStorage.setItem("robert.localRecommended.v2", "1");
        if (rec.ram_gb > 0 && rec.model !== localModelRef.current && !localStorage.getItem("robert.localModelChosen")) {
          setLocalModel(rec.model);
          localModelRef.current = rec.model;
        }
      })
      .catch(() => {});
  }, []);

  const setupLocalBrain = useCallback(async () => {
    setLocalSetup({ stage: "start", status: "Checking Ollama…", completed: 0, total: 0 });
    try {
      const st = await invoke<{ installed: boolean; running: boolean; models: string[]; has_model: boolean }>(
        "robert_setup_local",
        { model: localModelRef.current }
      );
      setLocalStatus(st);
    } catch (e: any) {
      setLocalSetup({ stage: "error", status: String(e), completed: 0, total: 0 });
    }
  }, []);

  // Done-for-you: with the local brain selected and not ready, start the
  // setup by itself (once per launch; Cancel stops it).
  const autoSetupTried = useRef(false);
  useEffect(() => {
    if (provider !== "local" || !localStatus || autoSetupTried.current) return;
    if (localStatus.running && localStatus.has_model) return;
    autoSetupTried.current = true;
    requestSetupRef.current?.("brain");
  }, [provider, localStatus]);

  // ── Solve screen: capture a region and send it to a vision model ──────────
  const visionCall = useCallback(async (imageB64: string): Promise<string> => {
    const prov = providerRef.current;
    // Include my real background so Solve can ANSWER a question aimed at me
    // (interview/application/screening) in first person, not just give steps.
    // Capped so a huge notes file doesn't blow the vision prompt.
    const bg = (notesRef.current || "").slice(0, 6000);
    const solveSystem = bg
      ? `${SOLVE_SYSTEM}\n\n## MY BACKGROUND (real facts about me — for any question aimed at me, answer in first person AS me using these)\n${bg}`
      : SOLVE_SYSTEM;
    const user = "Answer or solve what's in this screenshot. If it's a question directed at me, give my actual first-person answer, not steps.";
    if (prov === "local") {
      return await invoke<string>("robert_vision_local", {
        model: visionModelRef.current || "qwen2.5vl:7b",
        system: solveSystem,
        user,
        imageBase64: imageB64,
        maxTokens: 1500,
      });
    }
    const meta = CLOUD_PROVIDERS.find((p) => p.id === prov);
    const key = (cloudKeysRef.current[prov] || "").trim();
    if (!key) throw new Error(`Add your ${meta?.label ?? prov} API key in settings.`);
    const mdl = (cloudModelsRef.current[prov] || meta?.defaultModel || "").trim();
    if (prov === "anthropic") {
      return await invoke<string>("robert_vision_anthropic", {
        apiKey: key, model: mdl || "claude-opus-5", system: solveSystem,
        user, imageBase64: imageB64, maxTokens: 1500,
      });
    }
    const baseUrl = prov === "custom" ? customBaseUrlRef.current.trim() : meta?.baseUrl || "";
    return await invoke<string>("robert_vision_openai", {
      apiKey: key, model: mdl, system: solveSystem,
      user, imageBase64: imageB64, baseUrl, maxTokens: 1200,
    });
  }, []);

  const solveScreen = useCallback(async () => {
    setScreenError("");
    setScreenSolving(true);
    setScreenAnswer("");
    let un: undefined | (() => void);
    try {
      // one-shot: the next captured selection is the problem to solve
      un = await listen<string>("captured-selection", async (e) => {
        if (un) { un(); un = undefined; }
        const b64 = e.payload;
        if (!b64) { setScreenSolving(false); setScreenError("Nothing was captured."); return; }
        try {
          const out = await visionCall(b64);
          setScreenAnswer(out.trim());
          track("solve_screen", { ok: true, provider: providerRef.current });
        } catch (err: any) {
          setScreenError(String(err));
          track("error", { where: "solve_screen", msg: String(err).slice(0, 200) });
        } finally {
          setScreenSolving(false);
        }
      });
      await invoke("start_screen_capture");
    } catch (err: any) {
      if (un) un();
      setScreenSolving(false);
      setScreenError(String(err));
    }
  }, [visionCall]);

  // No-permission path: solve whatever image is on the clipboard (the OS
  // screenshot tool captured it, so Robert needs no screen-recording access).
  const solveClipboard = useCallback(async () => {
    setScreenError("");
    setScreenSolving(true);
    setScreenAnswer("");
    try {
      const b64 = await invoke<string>("robert_clipboard_image");
      const out = await visionCall(b64);
      setScreenAnswer(out.trim());
      track("solve_screen", { ok: true, provider: providerRef.current, via: "clipboard" });
    } catch (err: any) {
      setScreenError(String(err));
      track("error", { where: "solve_clipboard", msg: String(err).slice(0, 200) });
    } finally {
      setScreenSolving(false);
    }
  }, [visionCall, track]);

  const setupVisionModel = useCallback(async () => {
    setScreenError("");
    setLocalSetup({ stage: "start", status: `Downloading vision model ${visionModelRef.current}…`, completed: 0, total: 0 });
    try {
      await invoke("robert_setup_local", { model: visionModelRef.current || "qwen2.5vl:7b" });
      setLocalSetup({ stage: "done", status: "Vision model ready", completed: 1, total: 1 });
    } catch (e: any) {
      setLocalSetup({ stage: "error", status: String(e), completed: 0, total: 0 });
    }
  }, []);

  // Consent-gated entry points: the top-bar/settings buttons and the auto-setup
  // effect call these; the actual install/download runs only after Continue.
  const requestSetup = useCallback((kind: "brain" | "vision") => {
    if (setupConsentRef.current) {
      if (kind === "brain") setupLocalBrain();
      else setupVisionModel();
      return;
    }
    setDiskFree(null);
    diskFreeRef.current = null;
    invoke<number>("robert_disk_free").then((b) => { setDiskFree(b); diskFreeRef.current = b; }).catch(() => setDiskFree(null));
    setPendingSetup(kind);
  }, [setupLocalBrain, setupVisionModel]);
  requestSetupRef.current = requestSetup;

  // Estimated download size (bytes) for the pending setup, so the consent
  // window can state it and block if the disk cannot hold it.
  const setupSizeBytes = useCallback((kind: "brain" | "vision" | null): number => {
    const GB = 1024 * 1024 * 1024;
    if (kind === "vision") return 6.0 * GB; // qwen2.5vl:7b
    // brain: Ollama runtime (if missing) + chat model
    const ollama = localStatusRef.current?.installed ? 0 : 1.5 * GB;
    const chat = /e4b/i.test(localModelRef.current) ? 3.3 * GB : 7.5 * GB;
    return ollama + chat;
  }, []);

  const confirmSetup = useCallback(() => {
    const k = pendingSetupRef.current;
    // hard stop if the disk cannot hold the download plus a safety buffer
    const need = setupSizeBytes(k) + 2 * 1024 * 1024 * 1024;
    if (diskFreeRef.current !== null && diskFreeRef.current < need) {
      setLocalSetup({
        stage: "error",
        status: `Not enough storage: this needs about ${(need / 1e9).toFixed(1)} GB free, but only ${(diskFreeRef.current / 1e9).toFixed(1)} GB is available. Install cancelled.`,
        completed: 0,
        total: 0,
      });
      setPendingSetup(null);
      return;
    }
    setSetupConsent(true);
    setupConsentRef.current = true;
    setPendingSetup(null);
    if (k === "vision") setupVisionModel();
    else setupLocalBrain();
  }, [setupLocalBrain, setupVisionModel, setupSizeBytes]);

  const declineSetup = useCallback(() => {
    const k = pendingSetupRef.current;
    setPendingSetup(null);
    setLocalSetup({
      stage: "error",
      status:
        k === "vision"
          ? "Vision setup cancelled. Solve screen needs a vision model or a cloud key."
          : "Setup cancelled. The local brain was not installed; pick a cloud brain or try again.",
      completed: 0,
      total: 0,
    });
  }, []);

  useEffect(() => {
    invoke<string>("robert_models_location").then(setModelsLocation).catch(() => setModelsLocation(""));
  }, [localStatus]);

  // Re-ground when the notes folder changes (debounced while typing a path)
  // or when a different note file is selected (immediate).
  useEffect(() => {
    const t = setTimeout(() => reloadGrounding(), 800);
    return () => clearTimeout(t);
  }, [notesFolder, reloadGrounding]);
  useEffect(() => {
    reloadGrounding();
  }, [notesFile, useMemory, reloadGrounding]);

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
    addressedTo,
    participants,
    myName,
    setMyName,
    callType,
    setCallType,
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
    setLocalModel: (m: string) => {
      localStorage.setItem("robert.localModelChosen", "1");
      setLocalModel(m);
    },
    cancelLocalSetup,
    persona,
    personaCustomized,
    personaFile: PERSONA_FILE,
    openPersona,
    resetPersona,
    reloadPersona: loadPersona,
    voices: VOICES,
    voiceMax: VOICE_MAX,
    selectedVoices,
    applyVoices,
    voicePickerOpen,
    setVoicePickerOpen,
    onboardingStep,
    setOnboardingStep,
    finishOnboarding,
    notes,
    groundingSource,
    notesFolder,
    setNotesFolder,
    notesFile,
    setNotesFile,
    notesList,
    reloadGrounding,
    inbox,
    convertStatus,
    converting,
    autoConvert,
    convertFile,
    uploadFiles,
    refreshInbox,
    localStatus,
    localRamGb,
    outputDevice,
    setOutputDevice,
    outputDevices,
    refreshOutputDevices,
    localSetup,
    refreshLocalStatus,
    setupLocalBrain,
    requestSetup,
    pendingSetup,
    confirmSetup,
    declineSetup,
    diskFree,
    setupSizeBytes,
    telemetryOn,
    setTelemetry,
    modelsLocation,
    visionModel,
    setVisionModel,
    screenAnswer,
    setScreenAnswer,
    screenSolving,
    screenError,
    solveScreen,
    solveClipboard,
    setupVisionModel,
    recordMeetings,
    setRecordMeetings,
    micCapture,
    setMicCapture,
    useMemory,
    meetings,
    refreshMeetings,
    deleteMeeting,
    openPath,
    postMeeting,
    partial,
    lastTurn,
    turnsHeard,
    answersGiven,
    brainTest,
    testBrain,
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