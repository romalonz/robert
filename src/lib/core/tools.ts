// Robert Core — Tool registry (rec 4 / 24.4).
//
// A `Tool` is a named capability the agent can call without hard-coding an
// invoke. This is a structure-only seam: each tool wraps an EXISTING Tauri
// command, so behavior is unchanged. The first two tools are the app's existing
// proto-tools — keyless web research and note retrieval. The Phase-D agent loop
// consumes this registry; the live suggest() path is untouched.

import { invoke } from "@tauri-apps/api/core";

/** A named capability with a typed input/output. */
export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  run(input: Input): Promise<Output>;
}

/** In-memory registry the agent looks tools up in. */
export class ToolRegistry {
  private tools = new Map<string, Tool<any, any>>();

  register(tool: Tool<any, any>): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool<any, any>[] {
    return [...this.tools.values()];
  }

  async run(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.run(input);
  }
}

export interface ResearchInput {
  query: string;
}

/** Keyless web search (DuckDuckGo) → top snippets as plain text for the brain
 *  to synthesize. Wraps `robert_research_free`. */
export const researchTool: Tool<ResearchInput, string> = {
  name: "research",
  description:
    "Keyless web search (DuckDuckGo). Returns the top result snippets as plain text for the brain to synthesize into a speakable line.",
  run: ({ query }) => invoke<string>("robert_research_free", { query }),
};

export interface RetrieveNotesInput {
  query: string;
  notesFolder?: string | null;
  maxChars?: number;
  prefer?: string | null;
}

/** Pull the most relevant paragraphs from the user's notes for a query. Wraps
 *  `robert_retrieve_notes`. */
export const retrieveNotesTool: Tool<RetrieveNotesInput, string> = {
  name: "retrieve_notes",
  description:
    "Retrieve the most relevant paragraphs from the user's notes/memory for a query (lexical, folder-wide).",
  run: ({ query, notesFolder = null, maxChars, prefer = null }) =>
    invoke<string>("robert_retrieve_notes", { notesFolder, query, maxChars, prefer }),
};

/** A registry preloaded with Robert's existing proto-tools. */
export function defaultToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(researchTool).register(retrieveNotesTool);
}
