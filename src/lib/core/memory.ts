// Robert Core — MemoryStore (rec 3 / 24.3).
//
// Persistent memory behind one interface. Today it is the human-readable
// markdown "meeting memory" (<notes>/memory/*.md) plus the notes retriever;
// the interface is store-agnostic so a future episodic/semantic/vector store
// can drop in without touching callers. Structure-only: every method wraps an
// EXISTING command, behavior unchanged. Verbs mirror the review's MemoryStore.

import { invoke } from "@tauri-apps/api/core";

/** The markdown memory files Robert maintains across meetings, name → content
 *  (qa-bank.md · facts.md · people.md · decisions.md). */
export type MemoryFiles = Record<string, string>;

export interface MemorySearchOptions {
  notesFolder?: string | null;
  maxChars?: number;
  prefer?: string | null;
}

export interface MemoryStore {
  /** Recall everything currently held (the markdown memory files). */
  recall(notesFolder?: string | null): Promise<MemoryFiles>;
  /** Write/replace a named memory file. */
  remember(name: string, content: string, notesFolder?: string | null): Promise<void>;
  /** Clear a named memory file (writes it empty). */
  forget(name: string, notesFolder?: string | null): Promise<void>;
  /** Relevance search across notes + memory for a query. */
  search(query: string, opts?: MemorySearchOptions): Promise<string>;
}

/** MemoryStore backed by the existing markdown meeting-memory commands
 *  (robert_read_memory / robert_write_memory / robert_retrieve_notes). */
export const markdownMeetingMemory: MemoryStore = {
  recall: (notesFolder = null) =>
    invoke<MemoryFiles>("robert_read_memory", { notesFolder }),
  remember: (name, content, notesFolder = null) =>
    invoke<void>("robert_write_memory", { notesFolder, name, content }),
  forget: (name, notesFolder = null) =>
    invoke<void>("robert_write_memory", { notesFolder, name, content: "" }),
  search: (query, opts = {}) =>
    invoke<string>("robert_retrieve_notes", {
      notesFolder: opts.notesFolder ?? null,
      query,
      maxChars: opts.maxChars,
      prefer: opts.prefer ?? null,
    }),
};
