// Robert Core — ContextProvider (rec 24.1).
//
// The user's current computer context behind one interface: notes/files, the
// screen, the clipboard, and the live audio turn stream. Structure-only — each
// source wraps an EXISTING command or the existing robert://event stream, so
// behavior is unchanged. The audio subscription reuses the typed event catalog
// from lib/events.ts and is additive (a separate listener); it changes nothing
// on the live capture path until the agent loop opts in.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseRobertEvent, type RobertEvent } from "../events";

export interface Grounding {
  source: string;
  content: string;
}

export interface GroundingOptions {
  notesFolder?: string | null;
  notesFile?: string | null;
  useMemory?: boolean;
}

export interface NotesOptions {
  notesFolder?: string | null;
  maxChars?: number;
  prefer?: string | null;
}

/** A live turn surfaced from the audio context source. */
export interface AudioTurn {
  text: string;
  who: "me" | "them";
  final: boolean;
}

export interface ContextProvider {
  /** Assemble the meeting grounding from the notes folder (+ memory). */
  grounding(opts?: GroundingOptions): Promise<Grounding>;
  /** Relevant note paragraphs for a query. */
  notes(query: string, opts?: NotesOptions): Promise<string>;
  /** The selectable note files in the notes folder (newest first). */
  listNotes(notesFolder?: string | null): Promise<string[]>;
  /** Current screen as a base64 PNG. */
  screen(): Promise<string>;
  /** Clipboard image as a base64 PNG. */
  clipboardImage(): Promise<string>;
  /** Subscribe to live audio turns; resolves to an unsubscribe fn. */
  onAudio(cb: (turn: AudioTurn) => void): Promise<() => void>;
}

/** ContextProvider backed by Robert's existing desktop commands + event stream. */
export const desktopContext: ContextProvider = {
  grounding: (opts = {}) =>
    invoke<Grounding>("robert_load_grounding", {
      notesFolder: opts.notesFolder ?? null,
      notesFile: opts.notesFile ?? null,
      useMemory: opts.useMemory ?? true,
    }),
  notes: (query, opts = {}) =>
    invoke<string>("robert_retrieve_notes", {
      notesFolder: opts.notesFolder ?? null,
      query,
      maxChars: opts.maxChars,
      prefer: opts.prefer ?? null,
    }),
  listNotes: (notesFolder = null) =>
    invoke<string[]>("robert_list_notes", { notesFolder }),
  screen: () => invoke<string>("capture_to_base64"),
  clipboardImage: () => invoke<string>("robert_clipboard_image"),
  onAudio: (cb) =>
    listen<string>("robert://event", (e) => {
      const ev: RobertEvent | null = parseRobertEvent(e.payload);
      if (!ev) return;
      if (ev.type === "partial" || ev.type === "final") {
        cb({
          text: ev.text ?? "",
          who: ev.who === "me" ? "me" : "them",
          final: ev.type === "final",
        });
      }
    }),
};
