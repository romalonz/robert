// Conversation intelligence for Robert's auto mode.
// Classifies the live conversation regime from the far-end transcript, decides
// how long to hold the floor-yield window before answering, and detects when a
// transcribed line is actually me reading Robert's own suggestion back.
// Theory + taxonomy: docs/2026-08-26_conversation-intelligence-research.md

export type ConvKind =
  | "briefing" // they hold the floor, long multi-sentence turns
  | "qna" // questions directed at me; an answer is owed, fast
  | "challenge" // skeptical pushback; de-escalate + ground
  | "discussion" // default back-and-forth
  | "status" // stand-up / status cadence
  | "decision" // options / approvals on the table
  | "smalltalk"; // opening-closing ritual, no business

export interface ConvRead {
  kind: ConvKind;
  // ms of quiet after a final before the brain is called (floor-yield window)
  holdMs: number;
  // one line injected into the prompt so the brain answers in the right shape
  hint: string;
}

export interface DialogueTurn {
  who: "them" | "me";
  text: string;
}

const INTERROGATIVES =
  /^(what|how|why|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|should|shall|have|has|any\b|tell me|walk (me|us) through|explain)/i;

const CHALLENGE_MARKERS =
  /\b(that'?s not (right|true|correct|accurate)|are you sure|i don'?t (buy|think|agree|see how)|why would|doesn'?t (make sense|add up|work)|the problem with|i disagree|not convinced|prove|who (told|approved)|actually,|hold on|wait a (second|minute)|pushback|concern(ed|s)? (is|about|with)|risk(y| is)|waste of|what'?s the point)\b/i;

const SMALLTALK_MARKERS =
  /\b(good (morning|afternoon|evening)|how are you|how'?s it going|weekend|holiday|vacation|weather|nice to (see|meet)|long time|happy (monday|friday|birthday)|hope you'?re (well|doing))\b/i;

const STATUS_MARKERS =
  /\b(update|progress|status|blocked|blocker|on track|last (week|time|meeting)|next steps?|action items?|follow[- ]?ups?|since (we|our) last)\b/i;

const DECISION_MARKERS =
  /\b(decide|decision|options?|go with|approve|approval|sign[- ]?off|trade[- ]?offs?|budget|which (one|way|option)|green[- ]?light|move forward with)\b/i;

const BRIEFING_MARKERS =
  /\b(as you can see|next slide|moving on|agenda|let me (share|show|walk)|first(ly)?,|second(ly)?,|finally,|to summarize|the (main|key) (point|thing)s?)\b/i;

const ADDRESSED_TO_ME =
  /\b(you|your|romeo)\b/i;

function words(t: string): number {
  return t.trim().split(/\s+/).filter(Boolean).length;
}

function isQuestion(t: string): boolean {
  const s = t.trim();
  return /\?\s*$/.test(s) || INTERROGATIVES.test(s);
}

/// Read the conversation regime from recent labeled history + the segment the
/// far side is speaking right now. Cheap, deterministic, runs on every final.
export function readConversation(
  history: DialogueTurn[],
  segment: string
): ConvRead {
  const theirs = history.filter((t) => t.who === "them").slice(-6);
  const recentText = theirs.map((t) => t.text).concat(segment).join(" ");
  const segWords = words(segment);
  const avgTheirWords = theirs.length
    ? theirs.reduce((n, t) => n + words(t.text), 0) / theirs.length
    : 0;
  const lastTheirs = segment || theirs[theirs.length - 1]?.text || "";

  // Priority order matters: a direct question or a challenge beats regime
  // detection because an answer is owed NOW (adjacency pair).
  if (CHALLENGE_MARKERS.test(lastTheirs)) {
    return {
      kind: "challenge",
      holdMs: 700,
      hint:
        "They are pushing back or skeptical. Acknowledge their point first, then answer with the specific fact or number from my notes that addresses it, or a polite probing question. Calm, never defensive.",
    };
  }
  if (isQuestion(lastTheirs) && ADDRESSED_TO_ME.test(lastTheirs)) {
    return {
      kind: "qna",
      holdMs: 650,
      hint:
        "They asked ME a direct question. Answer it directly and confidently now, and back it with the specific number, name, or fact from my notes. No hedging.",
    };
  }
  if (SMALLTALK_MARKERS.test(lastTheirs) && segWords < 30) {
    return {
      kind: "smalltalk",
      holdMs: 850,
      hint:
        "Small talk / greeting ritual. One brief, warm, human line matching their energy, or WAIT. No business facts.",
    };
  }
  // Long multi-sentence floor-holding = briefing/presentation by them.
  if (segWords > 60 || avgTheirWords > 45 || BRIEFING_MARKERS.test(recentText)) {
    return {
      kind: "briefing",
      holdMs: 1600,
      hint:
        "They are presenting or explaining at length and just paused. Give me ONE short line for the pause: a brief acknowledgment plus one value-add, insight, or sharp question about what they said. Never a lecture. Only reply WAIT if they are obviously mid-sentence.",
    };
  }
  if (DECISION_MARKERS.test(recentText)) {
    return {
      kind: "decision",
      holdMs: 900,
      hint:
        "A decision is on the table. If asked, ONE clear recommendation with a one-line why. No fence-sitting.",
    };
  }
  if (STATUS_MARKERS.test(recentText)) {
    return {
      kind: "status",
      holdMs: 900,
      hint:
        "Status-update cadence. Speak only when my area is named or a question lands; keep status lines crisp and factual.",
    };
  }
  return {
    kind: "discussion",
    holdMs: 950,
    hint: "Normal back-and-forth. Respond when it is naturally my turn.",
  };
}

// Single backchannel/filler tokens. If a whole turn is only these, it is not a
// real question or statement, so it must not replace the current answer.
const FILLER_WORDS = new Set([
  "mm", "mmm", "mhm", "mhmm", "mmhmm", "mmhm", "hmm", "hm", "hmmm", "uh", "uhh",
  "um", "umm", "uhhuh", "huh", "ah", "ahh", "oh", "ohh", "eh", "er", "erm",
  "yeah", "yea", "ya", "yep", "yup", "yo", "ok", "okay", "k", "kay", "alright",
  "aight", "right", "sure", "gotcha", "exactly", "totally", "true", "fair",
  "nice", "cool", "wow", "really", "indeed", "yes", "no", "nope", "so", "well",
  "like", "anyway", "anyways", "correct", "agreed", "absolutely", "definitely",
  "perfect", "great", "good", "word", "bet", "facts", "oof", "hmph", "mkay",
]);

// Multi-word backchannels and common Whisper silence hallucinations (normalized).
const FILLER_PHRASES = new Set([
  "uh huh", "mm hmm", "i see", "i know", "got it", "got you", "makes sense",
  "fair enough", "for sure", "of course", "oh really", "oh okay", "oh ok",
  "all right", "you know", "no way", "oh wow", "i guess", "i mean", "right right",
  "yeah yeah", "ok ok", "okay okay", "mm hm",
  // common Whisper hallucinations on silence
  "thank you", "thank you very much", "thanks", "thanks for watching",
  "thank you for watching", "please subscribe", "like and subscribe", "bye",
  "bye bye", "goodbye", "you", "the", "okay thank you", "thank you so much",
]);

// Pure verbal acknowledgments ("I understand that", "that makes sense"): a
// listener signaling "keep going", not a turn to answer. Checked against the
// core of the turn after leading/trailing filler words are stripped, so
// "Okay, I understand that." and "Fair enough, okay." are caught too.
const ACK_RE =
  /^(?:i (?:get|hear|understand|see|agree|know|follow)(?: (?:you|that|it|this|completely|totally))?|that makes sense|makes sense|understood|good (?:point|one|to know)|fair (?:point|enough)|sounds (?:good|great|right)|(?:very )?interesting|nice one|well said|(?:duly )?noted|(?:i )?appreciate (?:that|it)|thanks for (?:that|sharing)|good to know|that'?s (?:right|true|fair|good|great|interesting|helpful|awesome|amazing)|you'?re right|exactly right|spot on|love (?:it|that)|there you go)$/;

/// True when a turn is only backchannel/filler, a pure acknowledgment, or a
/// Whisper hallucination.
export function isIgnorableTurn(raw: string): boolean {
  let t = raw.trim().toLowerCase();
  if (!t) return true;
  // drop bracketed non-speech tags and music notes: [music], (applause), ♪
  t = t.replace(/[[(][^\])]*[\])]/g, "").replace(/[♪♫🎵🎶]/g, "").trim();
  if (!t) return true;
  // normalize punctuation AND hyphens to spaces ("Mm-hmm." -> "mm hmm";
  // keeping hyphens let hyphenated backchannels slip past the filter)
  const norm = t.replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return true;
  const words = norm.split(" ");
  if (words.every((w) => FILLER_WORDS.has(w))) return true;
  // Judge the turn in four views: as-is, and with leading/trailing filler
  // words stripped ("Fair enough, okay." -> "fair enough"). Stripping both
  // edges at once would eat phrases whose own words are fillers, so each
  // view is tested independently.
  let s = 0;
  let e = words.length;
  while (s < words.length && FILLER_WORDS.has(words[s])) s++;
  while (e > 0 && FILLER_WORDS.has(words[e - 1])) e--;
  const views = new Set<string>([
    norm,
    words.slice(0, e).join(" "),
    words.slice(s).join(" "),
    s < e ? words.slice(s, e).join(" ") : "",
  ]);
  for (const v of views) {
    if (v && (FILLER_PHRASES.has(v) || ACK_RE.test(v))) return true;
  }
  return false;
}

/// Normalized similarity between an incoming final and a line Robert showed:
/// share of the shorter side's words contained in the other. Catches me
/// reading a suggestion aloud (with STT noise and small ad-libs).
export function matchesMyLine(turn: string, myLines: string[]): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);
  const a = norm(turn);
  if (a.length < 4) return false;
  for (const line of myLines) {
    const b = norm(line);
    if (b.length < 4) continue;
    const bset = new Set(b);
    const hits = a.filter((w) => bset.has(w)).length;
    const short = Math.min(a.length, b.length);
    if (hits / short >= 0.72) return true;
  }
  return false;
}
