# Group calls (2026-08-28)

Robert hears the far end of a call as ONE mixed stream (the audio output of
the chosen app). On a group call several people share that stream and there
is no speaker separation. `src/lib/group.ts` reads, per line and without a
model, who a line is addressed to and which group-call move it makes;
`readConversation` turns that into a read the brain is told about.

Settings: "Your name" (first name plus common mishearings, comma-separated;
matched with one edit of slack so "Romero"/"Romy" still count) and "Call
type" (auto / 1:1 / group; auto flips to group once two colleagues have been
addressed by name).

| They say | Read | Robert does |
|---|---|---|
| "<Me>, what's the status?" | qna → you | answers now (200 ms hold) |
| "Julie, can you cover the numbers?" | aside → Julie | stays silent, no brain call; the exchange stays in context |
| "Does anyone know…?", "Thoughts?" | room | one line to jump in with if it's my area, else WAIT |
| unnamed question in a group | room | mine if it follows what I said; else a jump-in line or WAIT |
| someone else answers a question that wasn't mine | addon | one add-on only if my notes hold something they missed |
| "Let's go around the room" | roundrobin | prepares my status update before my turn |
| "<Me>, over to you" / "you're up" | handoff | 3–4 sentence update from notes, never WAIT |
| "<Me>, can you send that by Friday?" | actionitem | accept + pin down what/when (lands in takeaways) |
| "<Me>? You there? On mute?" | checkin | "yes, I'm here" + the answer left open |
| "Hi all, this is Priya from finance" | (roster) | Priya joins "in the room" |
| "As <Me> built it…" (talked about, not to) | normal flow | no special handling |

1:1 calls keep the old behaviour ("you" = me; a name is a third party being
talked about, never an aside).

Prompt: on a group call the user turn carries `GROUP CALL: … I am <name>.
People heard so far: … This line is addressed to: …`. The summary prompt
attributes lines to named participants only when the transcript makes it
clear, otherwise "a participant".

Known limits (need Phase 2 mic capture): Robert cannot hear ME, so it cannot
tell whether I already answered; crosstalk that Whisper merges into one line
is read as one speaker; a colleague addressed only by a nickname Whisper
never capitalizes is not detected until it appears in vocative position.

Harness: `npx tsx scripts/group-harness.ts` (57 cases).
