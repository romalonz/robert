// Conversation intelligence for Robert's auto mode.
// Classifies the live conversation regime from the far-end transcript, decides
// how long to hold the floor-yield window before answering, and detects when a
// transcribed line is actually me reading Robert's own suggestion back.
// Theory + taxonomy: docs/2026-08-26_conversation-intelligence-research.md

import { readGroup, isQuestionLike } from "./group";
import type { GroupRead } from "./group";

export type ConvKind =
  | "briefing" // they hold the floor, long multi-sentence turns
  | "qna" // questions directed at me; an answer is owed, fast
  | "challenge" // skeptical pushback; de-escalate + ground
  | "discussion" // default back-and-forth
  | "status" // stand-up / status cadence
  | "decision" // options / approvals on the table
  | "smalltalk" // opening-closing ritual, no business
  // group-call reads (see ./group.ts)
  | "handoff" // the floor is mine now: update/answer, never WAIT
  | "checkin" // they are waiting on me ("you there?")
  | "actionitem" // a task is being assigned to me
  | "roundrobin" // updates from everyone; mine is coming, prepare it
  | "room" // open question to the group, no name
  | "addon" // someone else is answering; add only if I have something
  | "aside"; // addressed to a named colleague: listen, do not answer

export interface ConvRead {
  kind: ConvKind;
  // ms of quiet after a final before the brain is called (floor-yield window)
  holdMs: number;
  // one line injected into the prompt so the brain answers in the right shape
  hint: string;
  // group read of the latest line (who it is addressed to, group-call move)
  group?: GroupRead;
  // true when Robert should not call the brain at all for this turn
  silent?: boolean;
}

/// Who I am and who is in the room, for group-aware reads.
export interface ConvContext {
  // my name(s), lowercased (see parseAliases)
  aliases: string[];
  // colleague names heard so far this call
  roster: string[];
  // "one" = 1:1 call, "group" = several people, "auto" = infer from roster
  callType: "auto" | "one" | "group";
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
  segment: string,
  ctx?: ConvContext
): ConvRead {
  const theirs = history.filter((t) => t.who === "them").slice(-6);
  const recentText = theirs.map((t) => t.text).concat(segment).join(" ");
  const segWords = words(segment);
  const avgTheirWords = theirs.length
    ? theirs.reduce((n, t) => n + words(t.text), 0) / theirs.length
    : 0;
  const lastTheirs = segment || theirs[theirs.length - 1]?.text || "";

  // ── Group-call layer: who is this addressed to, which move is it? ──
  const aliases = ctx?.aliases ?? [];
  const roster = ctx?.roster ?? [];
  const isGroup =
    ctx?.callType === "group" || (ctx?.callType !== "one" && roster.length >= 2);
  const oneOnOne = ctx?.callType === "one" || (!isGroup && ctx?.callType !== "group");
  // read the LAST sentence they spoke: that is where the vocative/handoff lives
  const lastSentence =
    lastTheirs.split(/(?<=[.!?])\s+/).filter(Boolean).slice(-1)[0] || lastTheirs;
  const g = readGroup(lastSentence, aliases, roster, oneOnOne);
  if (g.addressee.to === "none" && lastSentence !== lastTheirs) {
    // a name earlier in the turn still tells us whose turn it is
    const whole = readGroup(lastTheirs, aliases, roster, oneOnOne);
    if (whole.addressee.to !== "none") {
      g.addressee = whole.addressee;
      g.names = whole.names;
    }
    if (!g.signal) g.signal = whole.signal;
  }
  const toMe = g.addressee.to === "me";
  const toOther = g.addressee.to === "other";

  if (g.signal === "checkin" && (toMe || oneOnOne || g.addressee.to === "none")) {
    return {
      kind: "checkin",
      holdMs: 150,
      group: g,
      hint:
        "They are waiting on me (checking if I am there or muted). Give me the line to jump back in with: a quick 'yes, I'm here' and then answer the last question that was left open in the conversation, if there is one. Never WAIT.",
    };
  }
  if (toOther) {
    return {
      kind: "aside",
      holdMs: 0,
      group: g,
      silent: true,
      hint: `This is addressed to ${g.addressee.name}, not me. I only listen.`,
    };
  }
  if (g.signal === "handoff" && (toMe || oneOnOne || isGroup)) {
    return {
      kind: "handoff",
      holdMs: 150,
      group: g,
      hint:
        "The floor was just handed to ME. Give me my update or answer now, 3 to 4 short spoken sentences built from my notes: where things stand, the one number that matters, what is next, and any blocker. Never WAIT.",
    };
  }
  if (g.signal === "roundrobin") {
    return {
      kind: "roundrobin",
      holdMs: 300,
      group: g,
      hint:
        "Updates are going around the room and my turn is coming. Prepare my status update now so it is ready when they get to me: 3 short spoken sentences from my notes, done, next, one number or blocker. Never WAIT.",
    };
  }
  if (g.signal === "actionitem" && (toMe || oneOnOne)) {
    return {
      kind: "actionitem",
      holdMs: 200,
      group: g,
      hint:
        "They are assigning ME a task. Give me one or two sentences that accept it and pin it down: confirm what exactly and by when, or ask the one clarifying question, using what my notes say about the current state. Never WAIT.",
    };
  }

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
  // In a 1:1 there is no one else the other side could be asking, so ANY question
  // they ask is mine to answer — not only explicitly second-person ones. (Group
  // calls still require the question to be addressed to me / the room.)
  if (isQuestion(lastTheirs) && (toMe || oneOnOne)) {
    return {
      kind: "qna",
      holdMs: 200,
      group: g,
      hint:
        "They asked ME a direct question. Answer it directly and confidently now, and back it with the specific number, name, or fact from my notes. No hedging.",
    };
  }
  if (SMALLTALK_MARKERS.test(lastTheirs) && segWords < 30) {
    return {
      kind: "smalltalk",
      holdMs: 400,
      group: g,
      hint:
        "Small talk / greeting ritual. One brief, warm, human line matching their energy, or WAIT. No business facts.",
    };
  }
  if (isGroup && isQuestionLike(lastSentence) && g.addressee.to === "group") {
    return {
      kind: "room",
      holdMs: 600,
      group: g,
      hint:
        "An open question to the whole room, no name attached. If my notes or my area cover it, give me one line to jump in with. If it is clearly someone else's area, reply EXACTLY WAIT.",
    };
  }
  if (isGroup && isQuestionLike(lastSentence) && g.addressee.to === "none") {
    return {
      kind: "room",
      holdMs: 500,
      group: g,
      hint:
        "A question in a group call with no name attached. If it follows something I said or lands in my area, it is mine: answer it directly with the specifics from my notes. Otherwise give me one short line I could jump in with, or reply EXACTLY WAIT if it is clearly for someone else.",
    };
  }
  // Someone else is answering the open question (group call, a declarative
  // turn right after a question that was not for me).
  if (isGroup && !isQuestionLike(lastSentence) && words(lastSentence) >= 12) {
    const prev = theirs[theirs.length - 1]?.text || "";
    const prevQ = prev && prev !== lastTheirs && isQuestionLike(prev);
    if (prevQ && !readGroup(prev, aliases, roster, false).addressee.to.startsWith("me")) {
      return {
        kind: "addon",
        holdMs: 800,
        group: g,
        hint:
          "Someone else is answering the last question. Give me ONE short add-on only if my notes hold a specific fact or number they missed; otherwise reply EXACTLY WAIT.",
      };
    }
  }
  // Long multi-sentence floor-holding = briefing/presentation by them.
  if (segWords > 60 || avgTheirWords > 45 || BRIEFING_MARKERS.test(recentText)) {
    return {
      kind: "briefing",
      holdMs: 1000,
      group: g,
      hint:
        "They are presenting or explaining at length and just paused. Give me ONE short line for the pause: a brief acknowledgment plus one value-add, insight, or sharp question about what they said. Never a lecture. Only reply WAIT if they are obviously mid-sentence.",
    };
  }
  if (DECISION_MARKERS.test(recentText)) {
    return {
      kind: "decision",
      holdMs: 500,
      group: g,
      hint:
        "A decision is on the table. If asked, ONE clear recommendation with a one-line why. No fence-sitting.",
    };
  }
  if (STATUS_MARKERS.test(recentText)) {
    return {
      kind: "status",
      holdMs: 500,
      group: g,
      hint:
        "Status-update cadence. Speak only when my area is named or a question lands; keep status lines crisp and factual. If several people are giving updates, mine should be the shortest and the most concrete.",
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
