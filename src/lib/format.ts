// Answer-format override: a meeting-knowledge file can dictate HOW Robert
// answers for that meeting (an interview file asking for bullet points under
// 300 characters, a board brief asking for one sentence). The section is
// injected as a hard override of the persona's prose/length rules and, when
// it names a character cap, enforced after generation too.

export interface AnswerFormat {
  text: string;
  // default character cap ("300 characters")
  maxChars: number | null;
  // cap for narrative questions ("narrative questions ...: up to 900 characters")
  extendedChars: number | null;
}

// A line of the format section that sets the NARRATIVE cap, not the default.
const NARRATIVE_LINE_RE = /\b(narrative|walk (?:me|us) through|history|background|extended|longer|end to end)\b/i;

/// "## Answer format" section of the loaded notes, if any: the text, the
/// default character cap and, when the section names one, the larger cap for
/// narrative questions.
export function extractAnswerFormat(notes: string): AnswerFormat | null {
  if (!notes) return null;
  const m = notes.match(/^##\s*answer format[^\n]*\n([\s\S]*?)(?=\n#{1,2}\s|$(?![\s\S]))/im);
  if (!m) return null;
  const text = m[1].trim();
  if (!text) return null;
  let maxChars: number | null = null;
  let extendedChars: number | null = null;
  for (const line of text.split("\n")) {
    const cap = line.match(/(\d{2,4})\s*(?:characters|chars)\b/i);
    if (!cap) continue;
    const n = parseInt(cap[1], 10);
    if (NARRATIVE_LINE_RE.test(line)) {
      if (extendedChars === null) extendedChars = n;
    } else if (maxChars === null) {
      maxChars = n;
    }
  }
  return { text, maxChars, extendedChars };
}

/// Questions that ask for a story, a history, or a walkthrough: "walk me
/// through your employment history", "tell me about yourself", "take us
/// through a project end to end", "give me an example of a time when".
export const NARRATIVE_Q_RE =
  /\b(walk (?:me|us) through|take (?:me|us) through|tell (?:me|us) (?:a bit |a little |more )?about (?:yourself|your(?:self)?|you|a time|an example|the project|a project)|employment history|work history|career (?:path|history|journey|so far)|your (?:background|journey|story|experience so far|cv|resume|résumé)|end to end|step by step|from start to finish|describe (?:a|the|your) (?:project|time|situation|process|role)|give (?:me|us) an example|(?:an )?example of (?:a time|when)|how did you get into|what have you been (?:doing|working on)|run (?:me|us) through|introduce yourself)\b/i;

export function isNarrativeQuestion(q: string): boolean {
  return NARRATIVE_Q_RE.test(q);
}

/// The character cap that applies to THIS question: the narrative cap when
/// the question asks for a story (falling back to three times the default),
/// otherwise the default.
export function capFor(fmt: AnswerFormat | null, question: string): number | null {
  if (!fmt) return null;
  if (isNarrativeQuestion(question)) {
    if (fmt.extendedChars) return fmt.extendedChars;
    return fmt.maxChars ? fmt.maxChars * 3 : null;
  }
  return fmt.maxChars;
}

/// Cut a line to the format's character cap at a bullet or sentence boundary.
export function capToFormat(line: string, maxChars: number | null): string {
  if (!maxChars || line.length <= Math.floor(maxChars * 1.15)) return line;
  const head = line.slice(0, maxChars);
  const nl = head.lastIndexOf("\n");
  if (nl > maxChars * 0.4) return head.slice(0, nl).trim();
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (end > maxChars * 0.4) return head.slice(0, end + 1).trim();
  return head.trim();
}


/// Models mix "*", "•" and "-" bullets; one shape reads better on screen.
export function normalizeBullets(line: string): string {
  return line.replace(/^\s*[*•·]\s+/gm, "- ");
}
