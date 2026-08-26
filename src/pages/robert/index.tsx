// Robert: a wide, short, glassy bar you drag anywhere (across both screens) by
// the top strip. The answer fills the bar; scroll down to adjust settings.
// Content-protected (off screen shares). Everything Robert needs lives here.

import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRobert, CLOUD_PROVIDERS } from "@/hooks/useRobert";

// Friendly names for the app picker. Matching is on the bundle-id root —
// MOST SPECIFIC PATTERNS FIRST (e.g. "gotoforteams" contains "teams", so
// GoTo must be tested before the Teams pattern).
const KNOWN_APPS: [RegExp, string][] = [
  [/system\.audio/i, "System audio (all apps)"],
  [/gotoforteams|logmein/i, "GoTo"],
  [/microsoft\.rdc/i, "Microsoft Remote Desktop"],
  [/microsoft\.edge|edgemac/i, "Edge"],
  [/teams/i, "Microsoft Teams"],
  [/brave/i, "Brave"],
  [/chrome/i, "Chrome"],
  [/zoom/i, "Zoom"],
  [/firefox/i, "Firefox"],
  [/webkit/i, "Safari (WebKit)"],
  [/slack/i, "Slack"],
  [/discord/i, "Discord"],
  [/fathom/i, "Fathom"],
  [/spotify/i, "Spotify"],
];
// Helper-process suffixes collapsed into their parent app, so one app = one
// option. The engine taps every process matching the root, so picking "Brave"
// captures Brave's whole audio output (main + all helpers).
const HELPER_SUFFIXES = new Set([
  "helper", "plugin", "renderer", "gpu", "modulehost", "utility", "service",
  "notificationcenter", "launcher", "webview", "crashpad", "audio",
]);
function rootOf(bundle: string): string {
  const parts = bundle.split(".");
  while (parts.length > 2 && HELPER_SUFFIXES.has(parts[parts.length - 1].toLowerCase()))
    parts.pop();
  return parts.join(".");
}
function labelOf(root: string): string {
  for (const [re, name] of KNOWN_APPS) if (re.test(root)) return name;
  return root.split(".").pop() || root;
}

export default function Robert() {
  const r = useRobert();

  // Refresh the audio-app list on open so the picker is ready to use.
  useEffect(() => {
    r.refreshProcesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One option per app: helpers collapsed into their root, system daemons
  // hidden, and roots that resolve to the same friendly label merged (keep
  // the shortest root — its substring match covers the descendants too).
  const apps = useMemo(() => {
    const byLabel = new Map<string, string>(); // label -> shortest root
    for (const p of r.processes) {
      const root = rootOf(p.bundle);
      const key = root.toLowerCase();
      if (key.startsWith("com.apple.") && !/webkit/i.test(key)) continue;
      if (key.startsWith("com.robertapp.")) continue; // never listen to Robert itself
      if (!key.includes(".")) continue; // bare daemon names, not real apps
      const label = labelOf(root);
      const existing = byLabel.get(label);
      if (!existing || key.length < existing.length) byLabel.set(label, key);
    }
    return [...byLabel.entries()]
      .map(([label, value]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [r.processes]);
  const targetInList = apps.some((a) => a.value === r.target);

  // Migrate legacy free-text targets ("teams", "brave") to the matching app
  // entry once the list is loaded.
  useEffect(() => {
    const t = r.target.trim().toLowerCase();
    if (!t || targetInList) return;
    const hit = apps.find((a) => a.value.includes(t));
    if (hit) r.setTarget(hit.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, targetInList]);

  // This window only: glassy (transparent body) and restore the cursor the app
  // otherwise hides globally via --cursor-type.
  useEffect(() => {
    const html = document.documentElement;
    const ph = html.style.background;
    const pb = document.body.style.background;
    html.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      html.style.background = ph;
      document.body.style.background = pb;
    };
  }, []);

  const statusLabel: Record<string, string> = {
    idle: "Idle",
    loading_model: "Loading…",
    ready: "Listening",
    stopped: "Stopped",
    error: "Error",
  };
  // Auto-grow the window to fit the answer (settings stay below the fold).
  // Before Start (initial setup) keep it tall so the settings are reachable.
  // Flexible: expands for stacked answers or a long Respond, retracts to a
  // slim bar when there's little to show. Capped to ~70% of the screen.
  const answerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let target: number;
    const maxH = Math.round((window.screen?.availHeight ?? 1000) * 0.7);
    if (!r.running && !r.suggestion) {
      target = 460;
    } else {
      const h = answerRef.current?.scrollHeight ?? 0;
      target = Math.max(150, Math.min(maxH, 44 + h + 18));
    }
    invoke("robert_set_height", { height: target }).catch(() => {});
  }, [
    r.suggestion,
    r.answers,
    r.partial,
    r.lastTurn,
    r.error,
    r.suggesting,
    r.lastRoute,
    r.running,
  ]);

  return (
    <div
      className="h-screen w-full overflow-y-auto bg-neutral-950/70 backdrop-blur-2xl text-neutral-100 select-text text-[13px]"
      style={{ ["--cursor-type" as any]: "default" }}
    >
      {/* Draggable top bar + primary controls */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-9 bg-neutral-950/50 backdrop-blur-xl border-b border-neutral-800/50">
        <span data-tauri-drag-region className="font-semibold text-sm select-none">
          Robert
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
            r.status === "ready"
              ? "border-emerald-500 text-emerald-400"
              : r.status === "error"
              ? "border-red-500 text-red-400"
              : "border-neutral-600 text-neutral-400"
          }`}
        >
          {statusLabel[r.status] ?? r.status}
        </span>
        {/* the big empty area drags the window across both screens */}
        <div data-tauri-drag-region className="flex-1 self-stretch" />
        <div className="flex items-center gap-0.5 bg-neutral-900/50 rounded p-0.5">
          {(["auto", "interview", "discussion", "listening"] as const).map((m) => (
            <button
              key={m}
              onClick={() => r.setMode(m)}
              className={`px-2 py-0.5 text-[11px] rounded ${
                r.mode === m
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {m === "auto"
                ? "Auto"
                : m === "interview"
                ? "Interview"
                : m === "discussion"
                ? "Discuss"
                : "Listen"}
            </button>
          ))}
        </div>
        <button
          onClick={r.respondNow}
          className="px-3 py-1 text-[11px] rounded bg-sky-600 hover:bg-sky-500 font-medium"
          title="Answer the last thing said, right now"
        >
          Respond
        </button>
        {r.running ? (
          <button
            onClick={r.stop}
            className="px-3 py-1 text-[11px] rounded bg-red-600 hover:bg-red-500 font-medium"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => r.start()}
            className="px-3 py-1 text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 font-medium"
          >
            Start
          </button>
        )}
      </div>

      {/* The answer fills the bar */}
      <div ref={answerRef} className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">
            {r.suggesting
              ? "thinking…"
              : r.lastRoute === "wait"
              ? "waiting for your cue"
              : r.lastRoute === "delivered"
              ? "you said it — listening"
              : ""}
            {r.mode === "auto" && r.convKind ? (
              <span className="ml-2 text-neutral-600">
                read: {r.convKind}
              </span>
            ) : null}
          </span>
          {r.suggestion && (
            <button
              onClick={() => navigator.clipboard.writeText(r.suggestion)}
              className="text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              Copy
            </button>
          )}
        </div>
        <div className="text-[15px] leading-relaxed whitespace-pre-wrap min-h-[2.5rem]">
          {r.suggestion ||
            (r.suggesting
              ? "Robert is thinking…"
              : "Suggestions appear here after each turn.")}
        </div>
        {/* Earlier answers survive rapid-fire questioning (dimmed, newest first) */}
        {r.answers
          .filter((a) => a.text !== r.suggestion)
          .slice(0, 2)
          .map((a) => (
            <div
              key={a.text.slice(0, 60)}
              className="mt-2 pt-2 border-t border-neutral-800/60"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-[12px] leading-snug text-neutral-400 whitespace-pre-wrap">
                  {a.text}
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(a.text)}
                  className="text-[10px] text-neutral-500 hover:text-neutral-300 shrink-0"
                >
                  Copy
                </button>
              </div>
              <div className="text-[10px] text-neutral-600 mt-0.5">
                re: {a.turn.slice(-90)}
              </div>
            </div>
          ))}
        {r.running && (
          <div className="text-[11px] text-neutral-500 italic mt-1">
            {r.partial ? `…${r.partial}` : "waiting for them to speak"}
          </div>
        )}
        {r.lastTurn && (
          <div className="text-[10px] text-neutral-600 mt-1">
            <span className="text-neutral-700">they said: </span>
            {r.lastTurn}
          </div>
        )}
        {r.error && (
          <div className="text-[11px] text-red-400 border border-red-900 bg-red-950/40 rounded px-2 py-1 mt-2">
            {r.error}
          </div>
        )}
      </div>

      {/* Settings: scroll down to adjust */}
      <div className="px-3 pb-3 pt-2 border-t border-neutral-800/50 flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-wide text-neutral-600">
          Settings
        </span>
        <div className="flex gap-2 flex-wrap items-end">
          <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="text-[10px] text-neutral-400">
              Listen to app{" "}
              {r.running && (
                <span className="text-emerald-400">
                  (tapping: {r.target})
                </span>
              )}
            </span>
            <div className="flex gap-1">
              <select
                value={targetInList ? r.target : "__current"}
                onChange={(e) => {
                  if (e.target.value !== "__current") r.setTarget(e.target.value);
                }}
                className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500 flex-1"
              >
                {!targetInList && (
                  <option value="__current">{r.target} (not running now)</option>
                )}
                {apps.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <button
                onClick={r.refreshProcesses}
                className="px-2 py-1 text-[10px] rounded border border-neutral-700 hover:bg-neutral-800 shrink-0"
                title="Refresh list of audio apps"
              >
                ↻
              </button>
            </div>
          </label>
          <span className="text-[10px] text-neutral-600 self-center">
            {r.running
              ? "changing app auto-restarts capture"
              : "captures that app's whole audio output"}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
            <span className="text-[10px] text-neutral-400">Brain</span>
            <select
              value={r.provider}
              onChange={(e) => r.setProvider(e.target.value as any)}
              className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500"
            >
              <option value="local">Local (Ollama) — no key needed</option>
              {CLOUD_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {r.provider === "local" ? (
            <label className="flex flex-col gap-1 flex-1 min-w-[150px]">
              <span className="text-[10px] text-neutral-400">Local model (Ollama)</span>
              <input
                value={r.localModel}
                onChange={(e) => r.setLocalModel(e.target.value)}
                placeholder="gemma4:12b"
                className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500"
              />
            </label>
          ) : (
            <>
              <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
                <span className="text-[10px] text-neutral-400">
                  {CLOUD_PROVIDERS.find((p) => p.id === r.provider)?.label} key
                </span>
                <input
                  type="password"
                  value={r.apiKey}
                  onChange={(e) => r.setApiKey(e.target.value)}
                  placeholder={
                    CLOUD_PROVIDERS.find((p) => p.id === r.provider)?.keyHint
                  }
                  className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500"
                />
              </label>
              <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
                <span className="text-[10px] text-neutral-400">Model</span>
                <input
                  value={r.model}
                  onChange={(e) => r.setModel(e.target.value)}
                  placeholder={
                    CLOUD_PROVIDERS.find((p) => p.id === r.provider)?.defaultModel
                  }
                  className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500"
                />
              </label>
            </>
          )}
        </div>
        {r.provider === "custom" && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-400">
              Custom base URL (OpenAI-compatible, e.g. https://api.example.com/v1)
            </span>
            <input
              value={r.customBaseUrl}
              onChange={(e) => r.setCustomBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500 font-mono"
            />
          </label>
        )}
        <div className="flex gap-2 items-end flex-wrap">
          <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="text-[10px] text-neutral-400 truncate leading-4">
              Notes folder (.md files)
            </span>
            <input
              value={r.notesFolder}
              onChange={(e) => r.setNotesFolder(e.target.value)}
              placeholder="~/RobertNotes"
              className="h-7 bg-neutral-900/60 border border-neutral-700 rounded px-2 text-xs outline-none focus:border-neutral-500 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="text-[10px] text-neutral-400 truncate leading-4">
              Meeting knowledge source
            </span>
            <select
              value={r.notesList.includes(r.notesFile) ? r.notesFile : ""}
              onChange={(e) => r.setNotesFile(e.target.value)}
              className="h-7 bg-neutral-900/60 border border-neutral-700 rounded px-2 text-xs outline-none focus:border-neutral-500"
            >
              <option value="">Auto — robert-brief.md, else all notes</option>
              {r.notesList.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={r.reloadGrounding}
            className="h-7 px-2 text-[11px] rounded border border-neutral-700 hover:bg-neutral-800 shrink-0"
            title="Reload notes from the folder"
          >
            Reload notes
          </button>
          <label className="h-7 flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer ml-auto shrink-0">
            <input
              type="checkbox"
              checked={r.autoStart}
              onChange={(e) => r.setAutoStart(e.target.checked)}
            />
            auto-start
          </label>
        </div>
        <span className="text-[10px] text-neutral-600">
          Point this at any folder of Markdown: an Obsidian vault works as-is.
          For Notion, export or sync pages as Markdown into the folder. A
          robert-brief.md inside it becomes the meeting brief and wins over
          everything else.
        </span>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-neutral-400">
            Persona &amp; rules (generic — yours to customize; no meeting facts
            belong here)
          </span>
          <textarea
            value={r.persona}
            onChange={(e) => r.setPersona(e.target.value)}
            rows={5}
            className="bg-neutral-900/60 border border-neutral-700 rounded px-2 py-1 text-xs outline-none focus:border-neutral-500 font-mono resize-y"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-neutral-400">
            Meeting knowledge — read-only, loaded
            {r.groundingSource ? ` from ${r.groundingSource}` : " from the notes folder"}
            . To change it, edit the .md files and hit Reload notes.
          </span>
          <textarea
            value={r.notes || "(nothing loaded from the notes folder yet)"}
            readOnly
            rows={5}
            className="bg-neutral-900/40 border border-neutral-800 rounded px-2 py-1 text-xs outline-none font-mono resize-y text-neutral-400"
          />
        </label>
        <span className="text-[10px] text-neutral-600">
          The local brain (default) runs fully on this machine via Ollama — no
          key, no cloud. Or bring your own key for DeepSeek, Claude, OpenAI,
          Groq, Gemini, OpenRouter, xAI, Mistral, or any OpenAI-compatible API.
          Audio is always transcribed on-device. Drag the window by the top bar.
        </span>
      </div>
    </div>
  );
}
