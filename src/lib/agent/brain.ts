// Agent — Brain adapter.
//
// The agent's default brain is the local Ollama model, reached through the Rust
// BrainProvider seam (robert_suggest_local → OllamaBrain). No API key; the same
// command the live path uses, so the agent shares the provider abstraction.

import { invoke } from "@tauri-apps/api/core";
import type { Brain } from "./types";

/** Local brain (default). Wraps robert_suggest_local. */
export const localBrain: Brain = {
  chat: (system, user, maxTokens) =>
    invoke<string>("robert_suggest_local", { model: "", system, user, maxTokens }),
};

/** Build a Brain over any command with the (model, system, user, maxTokens)
 *  shape — e.g. robert_suggest_anthropic — so the agent can swap providers
 *  without knowing which one it is. */
export function brainFromCommand(
  command: string,
  extra: Record<string, unknown> = {}
): Brain {
  return {
    chat: (system, user, maxTokens) =>
      invoke<string>(command, { system, user, maxTokens, ...extra }),
  };
}
