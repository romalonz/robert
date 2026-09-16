// The `robert://event` wire contract (rec 12) — a typed façade over the
// line-delimited JSON the capture engine emits (macOS Swift sidecar
// `main.swift`, Windows in-process `robert_win`), which `robert_start` relays
// verbatim. This is a TYPING seam only: nothing on the wire changes, the exact
// strings stay identical. The Rust-side mirror lives in
// `src-tauri/src/robert/events.rs`.

/** Capture-engine lifecycle stage carried by a `status` event. Known values:
 *  starting · ready · listening · stopped · error · loading_model. Typed as a
 *  plain string so unknown/future stages pass through untouched. */
export type RobertStatus = string;

/** One parsed line of the `robert://event` stream. `type` is the discriminant;
 *  the opt-in mic stream tags `partial`/`final` with `who: "me"`. */
export type RobertEvent =
  | { type: "status"; stage: RobertStatus }
  | { type: "partial"; text?: string; who?: string }
  | { type: "final"; text?: string; who?: string }
  | { type: "error"; message?: string }
  | { type: "process"; pid?: number; bundle?: string };

/** Parse one `robert://event` payload line into the typed union. Returns null
 *  when the line is not valid JSON — the same guard as the previous inline
 *  try/catch, so behavior is unchanged. */
export function parseRobertEvent(payload: string): RobertEvent | null {
  try {
    return JSON.parse(payload) as RobertEvent;
  } catch {
    return null;
  }
}

/** Progressive token stream for the local brain (event `robert://token`),
 *  emitted by `robert_suggest_local_stream`. `text` is the FULL text so far. */
export type RobertToken = { id: number; text: string; done?: boolean };

/** `robert://terminated` payload: the engine's exit code (or null). */
export type RobertTerminated = number | null;
