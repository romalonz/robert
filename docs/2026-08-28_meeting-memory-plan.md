# Meeting Memory: a Fathom-like layer for Robert (100% open source, 100% local)

**Goal.** Robert records each meeting (transcript first, audio optional), writes the key takeaways,
and learns from them so it answers faster and more precisely next time. When I answered differently
from Robert's suggestion, MY answer becomes the preferred one. Everything stays in a local folder.

## 0. Where it lives

```
~/RobertNotes/                         (Windows: C:\Users\<you>\RobertNotes)
  meetings/
    2026-08-28_1430_microsoft-teams/    one folder per meeting (date_time_target)
      transcript.jsonl                  raw event log (source of truth)
      transcript.md                     readable: [14:30:12] Them: ...  /  Me: ...  /  Robert: ...
      summary.md                        key takeaways (decisions, actions, Q&A, facts, open items)
      recording.wav                     ONLY if audio recording is switched on
  memory/                              auto-maintained, always in grounding, user-editable
    qa-bank.md                          question -> my best answer (my own words win)
    facts.md                            numbers and facts I have stated, with the meeting they came from
    people.md                           who is who, how they push, what they care about
    decisions.md                        decisions and open items across meetings
```
The install directory is not writable on macOS or Windows, so the notes folder is the right home:
it is already Robert's knowledge, it is user-visible, and `memory/*.md` flows into grounding with
zero new plumbing.

## 1. Session recording (during the meeting)

The frontend already holds every piece: far-end finals (Them), echo-detected reads (Me), every
suggestion shown, the conversation read, and whether a line was delivered. Today it throws that
away on Stop. Phase 1 persists it:

- On Start: create the meeting folder, write a header line (target app, mode, brain, notes source).
- On every event: append one JSON line to `transcript.jsonl`
  `{t, who: "them"|"me"|"robert", text, kind?: "qna"|"briefing"|..., delivered?: bool, ref?: id}`
- On Stop: render `transcript.md`, then run summarization (section 2).
- Red "REC" dot in the bar while a session is being logged; transcript logging is on by default,
  audio is OFF by default (see section 5).
- Audio (opt-in): the engines already own the 16 kHz mono stream. Add `--record <path>` to both
  engines (Swift: write WAV from the same buffer WhisperKit gets; Windows: same in `robert_win.rs`).
  Far-end audio only until Phase 2 adds the mic.

## 2. Key takeaways (right after Stop)

One brain call over `transcript.md` with a fixed schema, output written to `summary.md`:

```
# <Meeting title>  (date, duration, participants if named)
## Decisions
## Action items            (owner, what, by when if stated)
## Questions asked of me   (question -> what I answered -> Robert's suggestion -> used/adapted/ignored)
## Facts and numbers stated
## Open questions / follow-ups
## People                  (who said what, how they push)
```
Uses the selected brain (local by default). If a cloud brain is selected, the UI says plainly that
the transcript text will be sent to that provider for the summary, with a one-click "summarize
locally instead" (Ollama).

## 3. The learning loop (why it gets faster and more precise)

After the summary, a second brain call **merges** the meeting into the memory files instead of
appending blindly:

- `qa-bank.md`: for every question directed at me, store the question and the answer. **My own
  answer wins over Robert's suggestion** when they differ (the "used Robert as reference only" case).
  Dedupe by meaning; keep the newest, best-phrased version; keep the meeting reference.
- `facts.md`: exact numbers and facts stated, with source meeting. Contradictions are kept side by
  side with dates so Robert can say "as of the 27th it was X".
- `people.md`, `decisions.md`: same merge rule.

Effect on live answers:
1. **Precision.** The memory files are always in grounding (see section 4). The persona already
   demands exact numbers and my own register; now it has my own past answers to quote, so Robert
   sounds like me because it IS me, from last time.
2. **Speed, tier 1 (free).** A banked answer needs no reasoning: the model finds it in context and
   returns it; measured today, grounded lookups are the fastest answers Robert gives.
3. **Speed, tier 2 ("instant recall", Phase 3).** Before the brain is even called, match the incoming
   question against `qa-bank.md` locally (token overlap first; optional Ollama embeddings
   `nomic-embed-text` later). On a strong match show the banked answer immediately (<50 ms) with a
   small "from memory" tag, and let the brain's fresh answer replace it if it differs materially.

## 4. Grounding changes (small)

Loader priority becomes: selected file **or** brief **or** all notes, **plus** `memory/*.md`
always (capped, newest-first), unless "Use meeting memory" is switched off. A per-meeting
`summary.md` is just another selectable note, so "ground me on last Tuesday's meeting" is two clicks.

## 5. Recording management, privacy, consent

- Meetings panel in settings: date, target, duration, turns, size; Open folder; Delete; Re-summarize.
- Retention setting: keep all (default) / last N days / summaries only (transcripts deleted, memory kept).
- Audio recording is opt-in per session and shows the REC indicator. Recording laws differ by
  place (one-party vs all-party consent); the UI states that the user is responsible for consent
  and defaults to transcript-only, which is what Robert needs anyway.
- Nothing leaves the machine unless a cloud brain is selected, and then only text, and the UI says so.
- `memory/*.md` is plain text the user can read, correct, and delete. That is the whole trust model.

## 6. Phase 2: capture my side properly (the mic)

Today "Me" lines come from echo detection (reading Robert's line aloud) and are incomplete. Adding
microphone capture to both engines gives a true two-sided transcript (Fathom parity), makes the
qa-bank learning exact, and finally gives deterministic self-speech detection (any far-end final
overlapping mic activity is me) instead of heuristics. Cost: one more permission prompt (microphone),
and the mic stream is transcribed on-device like everything else.

## 7. Build order (recommendation)

| Phase | Scope | Size |
|---|---|---|
| 1 | transcript.jsonl/.md, REC indicator, summary.md, memory merge, memory in grounding, meetings list | ~1 day |
| 2 | mic capture in both engines, two-sided transcript, deterministic self-speech | ~1 day + Windows CI iterations |
| 3 | instant recall, embeddings option, retention policies, re-summarize, export | ~half day |

All open source, no new services, no new keys: Whisper (already), Ollama (already), Tauri fs
commands, Markdown. Start with Phase 1: it delivers the learning loop end to end and is pure
frontend + a few small Rust file commands, so it ships on both platforms from one commit.
