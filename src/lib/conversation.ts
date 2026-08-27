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
      holdMs: 250,
      hint:
        "They are pushing back or skeptical. Take their point seriously in plain words (no canned opener), then answer with the specific fact or number from my notes that addresses it, or a polite probing question. Calm, never defensive.",
    };
  }
  if (isQuestion(lastTheirs) && ADDRESSED_TO_ME.test(lastTheirs)) {
    return {
      kind: "qna",
      holdMs: 200,
      hint:
        "They asked ME a direct question. Answer it directly and confidently now, and back it with the specific number, name, or fact from my notes. No hedging.",
    };
  }
  if (SMALLTALK_MARKERS.test(lastTheirs) && segWords < 30) {
    return {
      kind: "smalltalk",
      holdMs: 400,
      hint:
        "Small talk / greeting ritual. One brief, warm, human line matching their energy, or WAIT. No business facts.",
    };
  }
  // Long multi-sentence floor-holding = briefing/presentation by them.
  if (segWords > 60 || avgTheirWords > 45 || BRIEFING_MARKERS.test(recentText)) {
    return {
      kind: "briefing",
      holdMs: 1000,
      hint:
        "They are presenting or explaining at length and just paused. Give me ONE short line for the pause: a brief acknowledgment plus one value-add, insight, or sharp question about what they said. Never a lecture. Only reply WAIT if they are obviously mid-sentence.",
    };
  }
  if (DECISION_MARKERS.test(recentText)) {
    return {
      kind: "decision",
      holdMs: 500,
      hint:
        "A decision is on the table. If asked, ONE clear recommendation with a one-line why. No fence-sitting.",
    };
  }
  if (STATUS_MARKERS.test(recentText)) {
    return {
      kind: "status",
      holdMs: 500,
      hint:
        "Status-update cadence. Speak only when my area is named or a question lands; keep status lines crisp and factual.",
    };
  }
  return {
    kind: "discussion",
    holdMs: 500,
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

// ─── Human voice filter ──────────────────────────────────────────────────────
// Robert's lines are SPOKEN. The tells that make them "sound like AI" are
// mostly openers and vocabulary, and they are deterministic enough to strip
// without a model. Sources: blader/humanizer (Wikipedia's "Signs of AI
// writing", 35 patterns) and jalaalrd/anti-ai-slop-writing (banned words,
// phrases, openers). Tailored here to conversational speech.

// Therapist / agreeable / announcement openers. Nobody says these on a call.
const TELL_OPENERS = [
  /^(great|good|excellent|fair|interesting|that'?s a (great|good|fair|valid|excellent)) (question|point)[.!,:]?\s*/i,
  /^(absolutely|certainly|sure|of course|exactly|indeed|definitely|understood|noted|right|correct)[.!,:]\s*/i,
  /^(i (completely |totally |fully )?(understand|hear|appreciate|see|get|acknowledge)) (your|the|that|where you'?re)[^.!?]*[.!?,]\s*/i,
  /^(i see why (that'?s|this is|you'?d be) [^.!?]*[.!?,])\s*/i,
  /^(that'?s (a )?(fair|valid|reasonable|good)( point| concern| take)?)[.!,]\s*/i,
  /^(you'?re (absolutely |totally |completely )?right)[.!,]\s*/i,
  /^(thanks?( you)? for (asking|raising|flagging|the question)[^.!?]*[.!?,])\s*/i,
  /^(to be (honest|fair|clear)|honestly|frankly|look|well|so)[,:]\s*/i,
  /^(it'?s (worth noting|important to note|worth mentioning) that)\s*/i,
  /^(the (short|simple|honest) answer is)[:,]?\s*/i,
];

// Word-level slop -> plain speech.
const SLOP_SWAPS: [RegExp, string][] = [
  [/\butili[sz]e(d|s)?\b/gi, "use$1"],
  [/\bleverag(e|es|ed|ing)\b/gi, "use"],
  [/\bcommence(d|s)?\b/gi, "start$1"],
  [/\bfacilitat(e|es|ed|ing)\b/gi, "help"],
  [/\bin order to\b/gi, "to"],
  [/\bat this point in time\b/gi, "right now"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bseamless(ly)?\b/gi, "smooth$1"],
  [/\brobust\b/gi, "solid"],
  [/\bstreamlin(e|es|ed|ing)\b/gi, "simplif$1"],
  [/\bensur(e|es|ing) that\b/gi, "mak$1 sure"],
  [/\bmoving forward,?\s*/gi, ""],
  [/\bgoing forward,?\s*/gi, ""],
  [/\bat the end of the day,?\s*/gi, ""],
  [/\bit'?s worth noting that\s*/gi, ""],
  [/\bit'?s important to note that\s*/gi, ""],
  [/\bin essence,?\s*/gi, ""],
  [/\bfundamentally,?\s*/gi, ""],
  [/\bat its core,?\s*/gi, ""],
  [/\brest assured,?\s*/gi, ""],
  [/\bvalue[- ]add(ed)?\b/gi, "useful"],
  [/\bsynerg(y|ies)\b/gi, "fit"],
  [/\bpain points?\b/gi, "problems"],
];

// Heavy tells that need a real rewrite, not a word swap.
const HEAVY_TELLS =
  /\b(not (just|only|merely) [^.]{2,60}?,? (but|it'?s) (also |about )?)|\b(delve|tapestry|testament to|landscape|pivotal|multifaceted|underscore[sd]?|garner|bolster|paramount|game[- ]chang|groundbreaking|cutting[- ]edge|transformative|unprecedented|holistic|synergi|empower|elevate|unlock the)/i;

export interface Humanized {
  text: string;
  changed: boolean;
  needsRewrite: boolean;
}

/// Strip the AI tells from a spoken line. Deterministic; safe to run on every
/// suggestion. `needsRewrite` asks the caller for ONE model rewrite when the
/// heavy patterns survive (they can't be fixed by substitution).
export function humanizeLine(raw: string): Humanized {
  let t = raw.trim();
  const before = t;
  // dashes -> spoken punctuation
  t = t.replace(/\s*[—–]\s*/g, ", ");
  // straight quotes
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // peel stacked openers (at most three passes)
  for (let i = 0; i < 3; i++) {
    let hit = false;
    for (const re of TELL_OPENERS) {
      if (re.test(t)) {
        t = t.replace(re, "");
        hit = true;
      }
    }
    if (!hit) break;
  }
  for (const [re, rep] of SLOP_SWAPS) t = t.replace(re, rep);
  // tidy: leading punctuation/space, capitalize, collapse spaces
  t = t.replace(/^[\s,.:;]+/, "").replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  if (t) t = t[0].toUpperCase() + t.slice(1);
  // if peeling emptied the line, keep the original rather than nothing
  if (t.length < 3) t = before;
  return {
    text: t,
    changed: t !== before,
    needsRewrite: HEAVY_TELLS.test(t),
  };
}
