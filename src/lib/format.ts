// Answer-format override: a meeting-knowledge file can dictate HOW Robert
// answers for that meeting (an interview file asking for bullet points under
// 300 characters, a board brief asking for one sentence). The section is
// injected as a hard override of the persona's prose/length rules and, when
// it names a character cap, enforced after generation too.

/// "## Answer format" section of the loaded notes, if any: the text, plus a
/// character cap when it names one ("300 characters").
export function extractAnswerFormat(
  notes: string
): { text: string; maxChars: number | null } | null {
  if (!notes) return null;
  const m = notes.match(/^##\s*answer format[^\n]*\n([\s\S]*?)(?=\n#{1,2}\s|$(?![\s\S]))/im);
  if (!m) return null;
  const text = m[1].trim();
  if (!text) return null;
  const cap = text.match(/(\d{2,4})\s*(?:characters|chars)\b/i);
  return { text, maxChars: cap ? parseInt(cap[1], 10) : null };
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
