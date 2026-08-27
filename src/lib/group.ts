// Group-call intelligence for Robert's auto mode.
//
// On a group call the captured far-end audio is ONE mixed stream: several
// people speak in the "Them" lines and there is no speaker separation. What
// Robert can still read, deterministically and per turn, is WHO a line is
// addressed to (me, a named colleague, the whole room, nobody in particular)
// and a handful of group-call moves that change what I need from Robert:
// a handoff to me, a round-robin coming my way, a task being assigned to me,
// a check-in ("you there?"), and someone else already answering a question.
//
// Everything here is text-only, cheap, and unit-tested by the harness in
// scripts/group-harness.ts.

export type AddresseeKind = "me" | "other" | "group" | "none";

export interface Addressee {
  to: AddresseeKind;
  // the colleague's name when to === "other"
  name?: string;
}

export type GroupSignal =
  | "handoff" // the floor is being handed to me ("over to you", "you're up")
  | "roundrobin" // updates from everyone are coming; mine will follow
  | "actionitem" // a task is being assigned ("can you send ... by Friday")
  | "checkin" // they are waiting on me ("you there?", "you're on mute")
  | null;

export interface GroupRead {
  addressee: Addressee;
  signal: GroupSignal;
  // every colleague name heard in this line (vocatives, introductions)
  names: string[];
}

// ─── my name and how Whisper mishears it ─────────────────────────────────────

export function parseAliases(raw: string): string[] {
  return raw
    .split(/[,;/\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2);
}

function levenshtein1(a: string, b: string): boolean {
  // true when edit distance <= 1 (one substitution, insertion, or deletion)
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/// Does this spoken token name me? Exact for short names, one edit of slack
/// for names of four letters or more (Whisper: "Romeo" -> "Romero", "Romy").
export function nameMatches(token: string, aliases: string[]): boolean {
  const t = token.toLowerCase().replace(/['’]s$/, "").replace(/[^\p{L}]/gu, "");
  if (t.length < 2) return false;
  for (const a of aliases) {
    if (t === a) return true;
    if (a.length >= 4 && t.length >= 4 && levenshtein1(t, a)) return true;
  }
  return false;
}

// ─── colleague names in vocative position ────────────────────────────────────

// Capitalized words that are never a person's name in vocative position.
const NOT_NAMES = new Set(
  (
    "i the a an and but so okay ok yes yeah no well now then also just hey hi hello " +
    "thanks thank right sure great good alright um uh oh ah we you they he she it " +
    "this that these those what how why when where who which can could would will " +
    "should do does did is are was were let's lets if in on at for to of by from " +
    "with about because actually basically anyway anyways look listen wait hold " +
    "first second third finally next last today tomorrow yesterday tonight " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october november december " +
    "teams zoom google microsoft excel word outlook slack meet webex sorry please " +
    "everyone everybody anyone anybody all team guys folks people question one two"
  ).split(" ")
);

const NAME = "([A-Z][a-z]{1,15})";
// Case-insensitive source for the phrase parts (Whisper capitalizes sentence
// starts: "Over to Julie", "Thanks Mark") while NAME itself stays capitalized.
function ci(src: string): string {
  return src.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
}
const LEAD =
  "(?:(?:" +
  ci("so|and|okay|ok|alright|hey|hi|um|uh|well|now|right|yeah|but|then|also|sorry") +
  "),?\\s+)*";

const VOCATIVE_RES: RegExp[] = [
  // "Julie, can you..." / "Okay Julie, ..."
  new RegExp(`^${LEAD}${NAME},\\s`),
  // "...what do you think, Julie?"
  new RegExp(`,\\s*${NAME}[?.!]*$`),
  // "over to Julie", "thanks Julie", "let's hear from Julie", "question for Julie"
  new RegExp(
    `\\b(?:${ci(
      "over to|back to|thanks|thank you|go ahead|what about|how about|let'?s (?:hear from|go to|start with|turn to)|up next is|next up,? is|next is|turn to|question for|one for|for you|from|with"
    )})\\s+${NAME}\\b`
  ),
  // "Julie can you...", "Julie what's your view"
  new RegExp(
    `^${LEAD}${NAME}\\s+(?:can|could|would|do|did|are|is|what|how|why|when|where|any|you|your|please|tell|walk|give|what'?s|how'?s|you'?re|were|will|should|have|has)\\b`
  ),
  // "Julie you're up", "Julie, go ahead", "Julie your thoughts"
  new RegExp(`\\b${NAME},?\\s+(?:you'?re (?:up|next|on)|go ahead|your (?:turn|update|thoughts|view|take))`),
  // introductions: "this is Julie", "Julie here", "Julie speaking", "Julie joined"
  new RegExp(`\\b(?:${ci("this is|it'?s|i'?m")})\\s+${NAME}\\b(?:\\s+(?:here|speaking|from))?`),
  new RegExp(`\\b${NAME}\\s+(?:here|speaking|has joined|just joined|joined)\\b`),
];

function cleanName(n: string): string | null {
  const w = n.trim();
  if (!w || NOT_NAMES.has(w.toLowerCase())) return null;
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}

/// Colleague names this line addresses or introduces (capitalized, vocative
/// position). Known roster names are also caught when Whisper lowercases them.
export function extractNames(text: string, roster: string[] = []): string[] {
  const found = new Set<string>();
  const t = text.trim();
  for (const re of VOCATIVE_RES) {
    const m = t.match(re);
    if (m && m[1]) {
      const n = cleanName(m[1]);
      if (n) found.add(n);
    }
  }
  // roster names in vocative shape regardless of case
  for (const r of roster) {
    const re = new RegExp(
      `(?:^${LEAD}${r},|,\\s*${r}[?.!]*$|\\b(?:over to|thanks|thank you|go ahead|what about|how about|hear from|question for|for you)\\s+${r}\\b|^${LEAD}${r}\\s+(?:can|could|would|do|did|are|is|what|how|why|when|where|you|your|please))`,
      "i"
    );
    if (re.test(t)) found.add(r);
  }
  return [...found];
}

// ─── group-call moves ────────────────────────────────────────────────────────

const GROUP_MARKERS =
  /\b(anyone|anybody|everyone|everybody|who (?:can|wants|has|knows|owns|is going)|thoughts\?|any (?:objections|thoughts|questions|concerns|volunteers|takers|input|other views)|all of you|the room|open (?:question|floor)|the team|team\?|guys\?|folks\?)/i;

const HANDOFF_RE =
  /\b(over to you|you'?re (?:up|next|on)|go ahead|your turn|floor is yours|take it away|why don'?t you (?:walk|take|give|start)|give us (?:an|your|the|a quick) update|your update|walk us through|bring us up to speed|where are we (?:on|with|at)|(?:can|could) you (?:update|fill|bring) (?:us|everyone|the team)|let'?s (?:hear from|go to|start with|turn to) you|what have you got|anything from you)\b/i;

const ROUNDROBIN_RE =
  /\b(go around(?: the (?:room|table|horn))?|quick round|round[- ]robin|round of updates|everyone (?:give|share|go)|each of you|one by one|let'?s do updates|updates from everyone|around the (?:room|table|horn)|quick updates from|starting with)\b/i;

const ACTION_RE =
  /\b(?:(?:can|could|would|will) you (?:send|share|follow up|take|own|get back|circulate|put together|pull|draft|set up|schedule|check|confirm|look into|handle|drive|update the|write up|prepare|make sure|get us|send over|ping|loop in)|please (?:send|share|follow up|circulate|put together|pull|draft|set up|schedule|check|confirm|look into|prepare|make sure|send over)|action item for|(?:take|own) (?:that|this|the) (?:one|action|item)|by (?:monday|tuesday|wednesday|thursday|friday|end of (?:day|week|month)|eod|eow|tomorrow|next week|close of business|cob))\b/i;

const CHECKIN_RE =
  /\b(you there|are you (?:there|on|with us|on mute|still there)|you'?re on mute|we lost you|can you hear (?:me|us)|did we lose you|still with us|are you still (?:there|on)|you might be on mute|i think you'?re muted|we can'?t hear you|you'?re breaking up)\b/i;

const INTERROGATIVE_RE =
  /^(what|how|why|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|should|shall|have|has|any\b|tell me|walk (me|us) through|explain)/i;

export function isQuestionLike(t: string): boolean {
  const s = t.trim();
  return /\?\s*$/.test(s) || INTERROGATIVE_RE.test(s);
}

/// Read one far-end line for who it is addressed to and which group-call move
/// it makes. `aliases` are my name(s), lowercased; `roster` the colleague
/// names heard so far; `oneOnOne` skips colleague detection (in a 1:1 "you"
/// is always me and any name is a third party being talked ABOUT).
export function readGroup(
  text: string,
  aliases: string[],
  roster: string[],
  oneOnOne = false
): GroupRead {
  const t = text.trim();
  const names = oneOnOne ? [] : extractNames(t, roster).filter((n) => !nameMatches(n, aliases));
  const tokens = t.split(/[^\p{L}'’]+/u).filter(Boolean);
  const mentionsMe = aliases.length > 0 && tokens.some((w) => nameMatches(w, aliases));
  const hasYou = /\b(you|your|you'?re|yours)\b/i.test(t);

  let signal: GroupSignal = null;
  if (CHECKIN_RE.test(t)) signal = "checkin";
  else if (ROUNDROBIN_RE.test(t)) signal = "roundrobin";
  else if (HANDOFF_RE.test(t)) signal = "handoff";
  else if (ACTION_RE.test(t) && hasYou) signal = "actionitem";

  let addressee: Addressee;
  if (mentionsMe) {
    addressee = { to: "me" };
  } else if (names.length) {
    addressee = { to: "other", name: names[0] };
  } else if (GROUP_MARKERS.test(t)) {
    addressee = { to: "group" };
  } else if (oneOnOne && hasYou) {
    addressee = { to: "me" };
  } else {
    addressee = { to: "none" };
  }

  // A handoff/check-in/task aimed at a colleague is theirs, not mine.
  if (addressee.to === "other" && signal && signal !== "roundrobin") signal = null;
  // A round-robin announcement that starts with someone else still means my
  // turn is coming; keep the signal, keep the addressee.
  return { addressee, signal, names };
}
