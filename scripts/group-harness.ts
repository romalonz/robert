// Deterministic harness for the group-call layer. Run: npx tsx scripts/group-harness.ts
import { readGroup, extractNames, nameMatches, parseAliases } from "../src/lib/group";
import { readConversation } from "../src/lib/conversation";
import type { DialogueTurn, ConvContext } from "../src/lib/conversation";
import { extractAnswerFormat, capToFormat, normalizeBullets } from "../src/lib/format";

let pass = 0;
let fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

const me = parseAliases("Romeo, Romy, Rome");
check("aliases", me, ["romeo", "romy", "rome"]);
check("name exact", nameMatches("Romeo", me), true);
check("name possessive", nameMatches("Romeo's", me), true);
check("name misheard +1", nameMatches("Romero", me), true);
check("name misheard sub", nameMatches("Romeu", me), true);
check("name two edits away", nameMatches("Roman", me), false);
check("name unrelated", nameMatches("Robert", me), false);
check("name short alias needs exact", nameMatches("Roma", ["rom"]), false);

// vocative extraction
check("voc lead", extractNames("Julie, can you cover the numbers?"), ["Julie"]);
check("voc lead w/ filler", extractNames("Okay so Julie, what do you think?"), ["Julie"]);
check("voc trail", extractNames("What's the timeline on that, Mark?"), ["Mark"]);
check("voc over to", extractNames("Over to Julie for the finance piece."), ["Julie"]);
check("voc thanks", extractNames("Thanks Mark, that's helpful."), ["Mark"]);
check("voc verb", extractNames("Julie can you walk us through the plan"), ["Julie"]);
check("voc intro", extractNames("Hi everyone, this is Priya from finance."), ["Priya"]);
check("voc joined", extractNames("Looks like Mark just joined."), ["Mark"]);
check("voc none: sentence start word", extractNames("Okay, let's move on."), []);
check("voc none: day", extractNames("Friday, we ship."), []);
check("voc none: talked about", extractNames("As Mark said earlier, the numbers moved."), []);
check("voc roster lowercase", extractNames("julie, anything to add?", ["Julie"]), ["Julie"]);

// readGroup
const rg = (t: string, roster: string[] = [], one = false) => {
  const r = readGroup(t, me, roster, one);
  return [r.addressee.to, r.addressee.name ?? "", r.signal];
};
check("rg me by name", rg("Romeo, what's the status on the report?"), ["me", "", null]);
check("rg me misheard", rg("Romero, where are we with that?"), ["me", "", "handoff"]);
check("rg other", rg("Julie, can you cover the numbers?"), ["other", "Julie", null]);
check("rg other's handoff is not mine", rg("Over to you, Julie."), ["other", "Julie", null]);
check("rg group", rg("Does anyone know the row count?"), ["group", "", null]);
check("rg thoughts", rg("Thoughts?"), ["group", "", null]);
check("rg none in group", rg("What's the row count?"), ["none", "", null]);
check("rg 1:1 you = me", rg("What do you think?", [], true), ["me", "", null]);
check("rg handoff me", rg("Romeo, over to you."), ["me", "", "handoff"]);
check("rg handoff you're up", rg("Romeo you're up."), ["me", "", "handoff"]);
check("rg roundrobin", rg("Let's go around the room, quick updates from everyone."), ["group", "", "roundrobin"]);
check("rg roundrobin starting other", rg("Let's go around, starting with Julie."), ["other", "Julie", "roundrobin"]);
check("rg action me", rg("Romeo, can you send that deck by Friday?"), ["me", "", "actionitem"]);
check("rg action other", rg("Mark, can you follow up with IT?"), ["other", "Mark", null]);
check("rg checkin", rg("Romeo? You there? I think you're on mute."), ["me", "", "checkin"]);
check("rg checkin no name", rg("Are you still there?"), ["none", "", "checkin"]);
check("rg mention not vocative", rg("As Romeo built it, the pull is read only."), ["me", "", null]);

// readConversation with context
const ctxG: ConvContext = { aliases: me, roster: ["Julie", "Mark"], callType: "auto" };
const ctx1: ConvContext = { aliases: me, roster: [], callType: "one" };
const H: DialogueTurn[] = [];
const rc = (seg: string, ctx: ConvContext, hist: DialogueTurn[] = H) => {
  const r = readConversation(hist, seg, ctx);
  return [r.kind, r.silent ? "silent" : "", r.holdMs];
};
check("rc aside", rc("Julie, can you cover the numbers?", ctxG), ["aside", "silent", 0]);
check("rc qna by name", rc("Romeo, what's the status on the report?", ctxG), ["qna", "", 200]);
check("rc qna misheard", rc("Romy, how many rows are we pulling?", ctxG), ["qna", "", 200]);
check("rc handoff", rc("Okay. Romeo, over to you.", ctxG), ["handoff", "", 150]);
check("rc handoff 2nd sentence", rc("Thanks Julie, that's clear. Romeo, where are we on the backlog report?", ctxG), ["handoff", "", 150]);
check("rc roundrobin", rc("Let's go around the room for quick updates.", ctxG), ["roundrobin", "", 300]);
check("rc actionitem", rc("Romeo, can you send the deck by Friday?", ctxG), ["actionitem", "", 200]);
check("rc checkin", rc("Romeo, are you there? You might be on mute.", ctxG), ["checkin", "", 150]);
check("rc room open", rc("Does anyone know the row count?", ctxG), ["room", "", 600]);
check("rc room unnamed", rc("What's the row count?", ctxG), ["room", "", 500]);
check("rc addon", rc(
  "So the way we did it was to pull from the system nightly and stage it in the workbook before anyone sees it.",
  ctxG,
  [{ who: "them", text: "Mark, how does the nightly pull actually work?" }]
), ["addon", "", 800]);
check("rc not addon when Q was mine", rc(
  "So the way we did it was to pull from the system nightly and stage it in the workbook before anyone sees it.",
  ctxG,
  [{ who: "them", text: "Romeo, how does the nightly pull actually work?" }]
), ["discussion", "", 500]);
check("rc 1:1 you", rc("What do you think about the rollout?", ctx1), ["qna", "", 200]);
check("rc 1:1 third party is not aside", rc("Julie, can you believe it, they shipped it.", ctx1), ["discussion", "", 500]);
check("rc 1:1 handoff", rc("Over to you.", ctx1), ["handoff", "", 150]);
check("rc challenge still wins", rc("Romeo, I don't buy that, are you sure?", ctxG), ["challenge", "", 250]);
check("rc smalltalk", rc("Good morning everyone, how was the weekend?", ctxG), ["smalltalk", "", 400]);
check("rc no ctx = legacy", readConversation(H, "What do you think?").kind, "qna");
check("rc auto w/ empty roster behaves 1:1", rc("What do you think?", { aliases: me, roster: [], callType: "auto" }), ["qna", "", 200]);
check("rc auto 1 name is still 1:1-ish", rc("What do you think?", { aliases: me, roster: ["Julie"], callType: "auto" }), ["qna", "", 200]);

// answer-format override
const notes = "# Interview\n\n## Role\nstuff\n\n## Answer format\n- At most 300 characters.\n- Bullet points only, 2 to 3 bullets.\n\n## Questions\nmore";
const fmt = extractAnswerFormat(notes);
check("fmt text", fmt?.text, "- At most 300 characters.\n- Bullet points only, 2 to 3 bullets.");
check("fmt cap", fmt?.maxChars, 300);
check("fmt none", extractAnswerFormat("# Notes\n## Role\nx"), null);
check("fmt last section", extractAnswerFormat("# N\n## Answer format\nOne sentence, 120 chars max.")?.maxChars, 120);
check("cap short passthrough", capToFormat("- a\n- b", 300), "- a\n- b");
const long = "- " + "x".repeat(150) + "\n- " + "y".repeat(150) + "\n- " + "z".repeat(150);
check("cap at bullet", capToFormat(long, 300), "- " + "x".repeat(150));
check("bullets normalized", normalizeBullets("* one\n• two\n- three"), "- one\n- two\n- three");
check("cap at sentence", capToFormat("First sentence here. " + "w".repeat(200) + ". More " + "q".repeat(200), 300).endsWith("."), true);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
