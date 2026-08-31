// Robert: a wide, short, glassy bar you drag anywhere (across both screens) by
// the top strip. The answer fills the bar; scroll down to adjust settings.
// Content-protected (off screen shares). Everything Robert needs lives here.

import { useEffect, useMemo, useRef, useState } from "react";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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

/// Checks the operator's signed update feed on launch. If a newer version is
/// published (and its signature verifies against the embedded public key), it
/// offers a one-click install. Only the operator can produce a valid update.
function UpdateBanner() {
  const [upd, setUpd] = useState<Update | null>(null);
  const [status, setStatus] = useState<"" | "downloading" | "installing" | "error">("");
  const [err, setErr] = useState("");
  useEffect(() => {
    checkUpdate()
      .then((u) => { if (u) setUpd(u); })
      .catch(() => {});
  }, []);
  if (!upd) return null;
  const install = async () => {
    try {
      setStatus("downloading");
      await upd.downloadAndInstall((e) => {
        if (e.event === "Finished") setStatus("installing");
      });
      await relaunch();
    } catch (e: any) {
      setErr(String(e));
      setStatus("error");
    }
  };
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-emerald-950/40 border-b border-emerald-900/50 text-[12px]">
      <span className="text-emerald-300">
        {status === "downloading" ? "Downloading update…" : status === "installing" ? "Installing… Robert will restart." : status === "error" ? `Update failed: ${err}` : `Update available: v${upd.version}`}
      </span>
      {status === "" && (
        <button onClick={install} className="ml-auto h-6 px-2.5 text-[11px] font-medium rounded-md bg-emerald-600 hover:bg-emerald-500">
          Install &amp; restart
        </button>
      )}
      {status === "error" && (
        <button onClick={install} className="ml-auto h-6 px-2.5 text-[11px] font-medium rounded-md bg-emerald-600 hover:bg-emerald-500">
          Retry
        </button>
      )}
    </div>
  );
}

type VoiceItem = { id: string; label: string; trait: string };

/// Modal multi-select for persona voices: searchable, capped, shows each trait.
function VoicePicker({
  voices, max, initial, onSave, onClose, title, subtitle,
}: {
  voices: VoiceItem[];
  max: number;
  initial: string[];
  onSave: (ids: string[]) => void;
  onClose?: () => void;
  title: string;
  subtitle: string;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>(initial.slice(0, max));
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return voices;
    return voices.filter((v) => v.label.toLowerCase().includes(t) || v.trait.toLowerCase().includes(t));
  }, [q, voices]);
  const toggle = (id: string) =>
    setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= max ? cur : [...cur, id]));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 rounded-2xl">
      <div className="w-full max-w-[620px] h-[82vh] flex flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
        <div className="px-4 pt-3 pb-2 border-b border-neutral-800">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-[11px] text-neutral-500 mt-0.5">{subtitle}</div>
          <div className="flex items-center gap-2 mt-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search 100+ characters or traits (e.g. calm, blunt, strategist)…"
              className="h-7 flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 text-xs outline-none focus:border-neutral-500 placeholder:text-neutral-600"
            />
            <span className={`text-[11px] ${sel.length >= max ? "text-amber-400" : "text-neutral-500"}`}>
              {sel.length}/{max}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {list.map((v) => {
            const on = sel.includes(v.id);
            const full = !on && sel.length >= max;
            return (
              <button
                key={v.id}
                onClick={() => toggle(v.id)}
                disabled={full}
                className={`w-full text-left flex gap-2 items-start px-2 py-1.5 rounded ${
                  on ? "bg-sky-950/50 border border-sky-800" : "border border-transparent hover:bg-neutral-800/60"
                } ${full ? "opacity-40" : ""}`}
              >
                <span className={`mt-[2px] h-3.5 w-3.5 shrink-0 rounded-sm border ${on ? "bg-sky-500 border-sky-500" : "border-neutral-600"}`} />
                <span className="min-w-0">
                  <span className="text-[12px] text-neutral-100">{v.label}</span>
                  <span className="block text-[11px] text-neutral-500 leading-snug">{v.trait}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-between items-center gap-2 px-4 py-3 border-t border-neutral-800">
          <span className="text-[10px] text-neutral-600">Up to {max}, so your voice stays coherent. Editable later in settings.</span>
          <div className="flex gap-2">
            {onClose && (
              <button onClick={onClose} className="h-7 px-3 text-[11px] font-medium rounded-md border border-neutral-700 hover:bg-neutral-800">
                Cancel
              </button>
            )}
            <button onClick={() => onSave(sel)} className="h-7 px-3 text-[11px] font-medium rounded-md bg-emerald-600 hover:bg-emerald-500">
              Save voice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const FIELD =
  "h-7 bg-neutral-900/60 border border-neutral-700 rounded px-2 text-xs text-neutral-100 outline-none focus:border-neutral-500 placeholder:text-neutral-600";
const BTN =
  "h-7 px-2.5 text-[11px] rounded border border-neutral-700 hover:bg-neutral-800 shrink-0 disabled:opacity-50 text-neutral-200";

/// One settings row: uppercase header on the left (hover it for the
/// explanation), controls on the right. Keeps the panel free of paragraphs.
function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="w-[76px] shrink-0 h-7 flex items-center text-[10px] uppercase tracking-wide text-neutral-500 cursor-help select-none"
        title={hint}
      >
        {title}
        <span className="ml-1 text-neutral-700">ⓘ</span>
      </span>
      <div className="flex-1 flex items-center gap-2 flex-wrap min-w-0">{children}</div>
    </div>
  );
}

type Opt = { value: string; label: string; hint?: string };
/// A dropdown that opens as a clean, grown-window modal (like the voice picker)
/// instead of a cramped native select. Single-select, searchable when long.
function SelectField({ value, options, onChange, placeholder, openKey, openPicker, setOpenPicker, className }: {
  value: string; options: Opt[]; onChange: (v: string) => void; placeholder?: string;
  openKey: string; openPicker: string | null; setOpenPicker: (k: string | null) => void; className?: string;
}) {
  const open = openPicker === openKey;
  const [q, setQ] = useState("");
  const cur = options.find((o) => o.value === value);
  const list = q.trim() ? options.filter((o) => (o.label + " " + (o.hint || "")).toLowerCase().includes(q.trim().toLowerCase())) : options;
  return (
    <>
      <button type="button" onClick={() => setOpenPicker(open ? null : openKey)}
        className={(className || FIELD) + " flex items-center justify-between gap-2 text-left"}>
        <span className="truncate">{cur ? cur.label : (placeholder || "Select…")}</span>
        <span className="opacity-50 shrink-0 text-[10px]">▾</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 rounded-2xl" onClick={() => setOpenPicker(null)}>
          <div className="w-full max-w-[520px] max-h-[82vh] flex flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
            {options.length > 8 && (
              <div className="p-2 border-b border-neutral-800">
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
                  className="h-7 w-full bg-neutral-800 border border-neutral-700 rounded px-2 text-xs text-neutral-100 outline-none focus:border-neutral-500 placeholder:text-neutral-600" />
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-2">
              {list.map((o) => (
                <button key={o.value} type="button"
                  onClick={() => { onChange(o.value); setOpenPicker(null); setQ(""); }}
                  className={`w-full text-left flex flex-col px-2 py-1.5 rounded ${o.value === value ? "bg-sky-950/50 border border-sky-800" : "border border-transparent hover:bg-neutral-800/60"}`}>
                  <span className="text-[12px] text-neutral-100">{o.label}</span>
                  {o.hint && <span className="text-[11px] text-neutral-500 leading-snug">{o.hint}</span>}
                </button>
              ))}
              {list.length === 0 && <div className="text-[11px] text-neutral-500 px-2 py-3">No matches.</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/// Render a suggested line so bullet answers breathe: each "- " / "*" / "•"
/// line becomes a spaced bullet row, plain lines become spaced paragraphs.
/// Display only; the underlying text is unchanged.
function AnswerBody({ text, size }: { text: string; size: "lg" | "sm" }) {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""));
  const base = size === "lg" ? "text-[15px] leading-7" : "text-[12px] leading-6 text-neutral-400";
  return (
    <div className={`${base} whitespace-pre-wrap space-y-1.5`}>
      {lines.map((l, i) => {
        const m = l.match(/^\s*([-*•])\s+(.*)$/);
        if (m) {
          return (
            <div key={i} className="flex gap-2">
              <span className="select-none opacity-50 mt-[1px]">•</span>
              <span className="flex-1">{m[2]}</span>
            </div>
          );
        }
        return <div key={i}>{l}</div>;
      })}
    </div>
  );
}

export default function Robert() {
  const r = useRobert();
  const [showNotes, setShowNotes] = useState(false);

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
    // Common targets stay selectable even when the app isn't running yet, so
    // a target can be picked before the meeting app launches. Marked in the
    // label; a running app with the same label replaces the placeholder.
    const PINNED: [string, string][] = [
      ["Microsoft Teams", "com.microsoft.teams2"],
      ["Zoom", "us.zoom.xos"],
      ["Brave", "com.brave.browser"],
      ["Chrome", "com.google.chrome"],
      ["Safari (WebKit)", "com.apple.webkit"],
      ["Slack", "com.tinyspeck.slackmacgap"],
      ["Discord", "com.hnc.discord"],
    ];
    const running = new Set<string>();
    for (const p of r.processes) {
      const root = rootOf(p.bundle);
      const key = root.toLowerCase();
      if (key.startsWith("com.apple.") && !/webkit/i.test(key)) continue;
      if (key.startsWith("com.robertapp.")) continue; // never listen to Robert itself
      if (!key.includes(".")) continue; // bare daemon names, not real apps
      const label = labelOf(root);
      running.add(label);
      const existing = byLabel.get(label);
      if (!existing || key.length < existing.length) byLabel.set(label, key);
    }
    for (const [label, value] of PINNED) {
      if (!running.has(label)) byLabel.set(`${label} (not running)`, value);
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
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  // A modal (voice picker, onboarding, consent) needs real room; the window is
  // otherwise a short bar and a viewport-sized modal renders tiny.
  const modalOpen =
    !!r.pendingSetup || r.voicePickerOpen || r.onboardingStep !== null || openPicker !== null;
  useEffect(() => {
    if (!modalOpen) return;
    const screenH = window.screen?.availHeight ?? 900;
    const screenW = window.screen?.availWidth ?? 1200;
    const w = Math.min(760, Math.round(screenW * 0.8));
    const h = Math.min(700, Math.round(screenH * 0.82));
    invoke("robert_set_size", { width: w, height: h }).catch(() => {});
    // no cleanup: when the modal closes, modalOpen flips false and the content
    // effect below restores the default width + the right height in one step.
  }, [modalOpen]);
  useEffect(() => {
    if (modalOpen) return; // don't shrink the window out from under a modal
    let target: number;
    const maxH = Math.round((window.screen?.availHeight ?? 1000) * 0.7);
    if (!r.running && !r.suggestion) {
      target = 460;
    } else {
      const h = answerRef.current?.scrollHeight ?? 0;
      target = Math.max(150, Math.min(maxH, 44 + h + 18));
    }
    invoke("robert_set_size", { width: 600, height: target }).catch(() => {});
  }, [
    modalOpen,
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
      className="h-screen w-full overflow-y-auto rounded-2xl bg-neutral-950/70 backdrop-blur-2xl text-neutral-100 select-text text-[13px]"
      style={{ ["--cursor-type" as any]: "default" }}
    >
      <UpdateBanner />
      {/* Consent gate: no install/download happens until the user says Continue */}
      {r.pendingSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 rounded-2xl">
          <div className="w-full max-w-[420px] rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl">
            <div className="text-sm font-semibold mb-1">
              {r.pendingSetup === "vision" ? "Download the vision model?" : "Set up the local AI brain?"}
            </div>
            <p className="text-[12px] leading-6 text-neutral-400">
              {r.pendingSetup === "vision"
                ? "Robert will download a vision model (about 6 GB) so Solve screen works offline. It is saved in your Robert folder. This can take a few minutes."
                : "Robert will install Ollama if needed and download the local model (about 7.5 GB). Everything is saved in your Robert folder and runs on this machine. This can take several minutes."}
            </p>
            {(() => {
              const need = r.setupSizeBytes(r.pendingSetup) + 2 * 1024 * 1024 * 1024;
              const dl = r.setupSizeBytes(r.pendingSetup);
              const enough = r.diskFree === null || r.diskFree >= need;
              return (
                <div className="mt-3 rounded border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-[11px]">
                  <div className="flex justify-between text-neutral-300">
                    <span>Download size</span>
                    <span>~{(dl / 1e9).toFixed(1)} GB</span>
                  </div>
                  <div className="flex justify-between text-neutral-400 mt-0.5">
                    <span>Free space on this machine</span>
                    <span>{r.diskFree === null ? "checking…" : `${(r.diskFree / 1e9).toFixed(1)} GB`}</span>
                  </div>
                  {!enough && (
                    <div className="mt-1.5 text-red-400">
                      Not enough storage. Free up space (need about {(need / 1e9).toFixed(1)} GB including a safety buffer) or use a cloud brain instead.
                    </div>
                  )}
                </div>
              );
            })()}
            <p className="text-[11px] text-neutral-500 mt-2">
              Nothing is downloaded until you choose Continue. You can also cancel and use a cloud brain with your own key instead.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={r.declineSetup}
                className="h-7 px-3 text-[11px] font-medium rounded-md border border-neutral-700 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                onClick={r.confirmSetup}
                disabled={r.diskFree !== null && r.diskFree < r.setupSizeBytes(r.pendingSetup) + 2 * 1024 * 1024 * 1024}
                className="h-7 px-3 text-[11px] font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-run onboarding: step 1 résumé (recommended), step 2 voice */}
      {r.onboardingStep === "resume" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 rounded-2xl">
          <div className="w-full max-w-[440px] rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-xl">
            <div className="text-sm font-semibold mb-1">Welcome to Robert. Add your résumé?</div>
            <p className="text-[12px] leading-6 text-neutral-400">
              Highly recommended. Robert turns your résumé into a profile it uses to tailor
              every answer to your real experience, and to map any job description you add
              later. It stays on this machine.
            </p>
            <p className="text-[11px] text-neutral-500 mt-2">pdf, docx, txt, or md. You can skip and add it anytime.</p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => r.setOnboardingStep("voice")}
                className="h-7 px-3 text-[11px] font-medium rounded-md border border-neutral-700 hover:bg-neutral-800"
              >
                Skip
              </button>
              <label className="h-7 px-3 text-[11px] font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 flex items-center cursor-pointer">
                Add résumé
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,.text,.md,.rtf"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) r.uploadFiles(e.target.files);
                    e.currentTarget.value = "";
                    r.setOnboardingStep("voice");
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      )}
      {r.onboardingStep === "voice" && (
        <VoicePicker
          voices={r.voices}
          max={r.voiceMax}
          initial={r.selectedVoices}
          title="Pick Robert's voice"
          subtitle="Choose up to 3 characters whose speaking style shapes how Robert talks. This becomes your voice and is used in every answer."
          onSave={(ids) => { r.applyVoices(ids); r.finishOnboarding(); if (r.provider === "local") r.requestSetup("brain"); }}
          onClose={() => { r.finishOnboarding(); if (r.provider === "local") r.requestSetup("brain"); }}
        />
      )}
      {/* Voice picker opened later from settings */}
      {r.voicePickerOpen && r.onboardingStep === null && (
        <VoicePicker
          voices={r.voices}
          max={r.voiceMax}
          initial={r.selectedVoices}
          title="Choose Robert's voice"
          subtitle="Up to 3 characters shape how Robert talks. Saved into your persona file."
          onSave={(ids) => { r.applyVoices(ids); r.setVoicePickerOpen(false); }}
          onClose={() => r.setVoicePickerOpen(false)}
        />
      )}

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
        {r.running && r.recordMeetings && (
          <span className="text-[10px] text-red-400 select-none" title="Transcript is being logged to your notes folder">
            ● REC
          </span>
        )}
        {r.postMeeting && (
          <span className="text-[10px] text-amber-300 select-none">{r.postMeeting}</span>
        )}
        {/* the big empty area drags the window across both screens */}
        <div data-tauri-drag-region className="flex-1 self-stretch" />
        <div className="flex items-center h-7 bg-neutral-800 border border-neutral-700 rounded-md p-0.5">
          {(["auto", "listening"] as const).map((m) => (
            <button
              key={m}
              onClick={() => r.setMode(m)}
              className={`h-6 px-3 text-[11px] font-medium rounded transition-colors ${
                r.mode === m
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
              title={
                m === "auto"
                  ? "Reads the room: questions, pushback, briefings, group handoffs. Interview files switch it to interview pacing by themselves."
                  : "Stay quiet while you present; answer only when asked directly."
              }
            >
              {m === "auto" ? "Auto" : "Listen"}
            </button>
          ))}
        </div>
        <button
          onClick={r.solveScreen}
          disabled={r.screenSolving}
          className="h-7 px-3 text-[11px] font-medium rounded-md bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 disabled:opacity-50"
          title="Snip a coding or technical problem on your screen and get a full solution (uses the selected brain's vision model)"
        >
          {r.screenSolving ? "Solving…" : "Solve screen"}
        </button>
        <button
          onClick={r.respondNow}
          className="h-7 px-3 text-[11px] font-medium rounded-md bg-neutral-800 hover:bg-neutral-700 border border-neutral-700"
          title="Answer the last thing said, right now"
        >
          Respond
        </button>
        {r.running ? (
          <button
            onClick={r.stop}
            className="h-7 px-3 text-[11px] font-medium rounded-md bg-red-600 hover:bg-red-500"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => r.start()}
            className="h-7 px-3 text-[11px] font-medium rounded-md bg-emerald-600 hover:bg-emerald-500"
          >
            Start
          </button>
        )}
      </div>

      {/* The answer fills the bar */}
      <div ref={answerRef} className="px-4 py-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">
            {r.suggesting
              ? "thinking…"
              : r.lastRoute === "wait"
              ? "waiting for your cue"
              : r.lastRoute === "delivered"
              ? "you said it — listening"
              : r.lastRoute === "aside"
              ? `asked of ${r.addressedTo || "someone else"} — listening`
              : ""}
            {r.mode === "auto" && r.convKind ? (
              <span className="ml-2 text-neutral-600">
                read: {r.convKind}
                {r.addressedTo ? ` → ${r.addressedTo}` : ""}
              </span>
            ) : null}
            {r.participants.length > 0 ? (
              <span className="ml-2 text-neutral-600">
                in the room: {r.participants.join(", ")}
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
        <div className="min-h-[2.5rem]">
          {r.suggestion ? (
            <AnswerBody text={r.suggestion} size="lg" />
          ) : (
            <div className="text-[15px] leading-7 text-neutral-500">
              {r.suggesting ? "Robert is thinking…" : "Suggestions appear here after each turn."}
            </div>
          )}
        </div>
        {/* Earlier answers survive rapid-fire questioning (dimmed, newest first) */}
        {r.answers
          .filter((a) => a.text !== r.suggestion)
          .slice(0, 2)
          .map((a) => (
            <div
              key={a.text.slice(0, 60)}
              className="mt-3 pt-3 border-t border-neutral-800/60"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <AnswerBody text={a.text} size="sm" />
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
            <span className="not-italic text-neutral-600">
              {"  ·  heard "}
              {r.turnsHeard}
              {" · answered "}
              {r.answersGiven}
            </span>
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

      {/* Solve-screen result: full solution to a snipped technical problem */}
      {(r.screenSolving || r.screenAnswer || r.screenError) && (
        <div className="mx-4 mb-2 rounded border border-sky-900/60 bg-sky-950/20">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-sky-900/40">
            <span className="text-[10px] uppercase tracking-wide text-sky-400">
              Screen answer {r.screenSolving ? "· solving…" : ""}
            </span>
            <div className="flex items-center gap-2">
              {r.screenAnswer && (
                <button
                  onClick={() => navigator.clipboard.writeText(r.screenAnswer)}
                  className="text-[11px] text-neutral-400 hover:text-neutral-200"
                >
                  Copy
                </button>
              )}
              {(r.screenAnswer || r.screenError) && (
                <button
                  onClick={() => { r.setScreenAnswer(""); }}
                  className="text-[11px] text-neutral-500 hover:text-neutral-300"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          {r.screenError ? (
            <div className="px-3 py-2 text-[11px] text-red-400">{r.screenError}</div>
          ) : (
            <pre className="px-3 py-2 text-[12px] leading-6 text-neutral-200 whitespace-pre-wrap font-mono max-h-[40vh] overflow-y-auto">
{r.screenAnswer || "Drag a rectangle around the problem on your screen…"}
            </pre>
          )}
        </div>
      )}

      {/* Settings: one row per section, header left, controls right. Explanations
          live in tooltips (hover the header), not in the panel. */}
      <div className="px-3 pb-3 pt-2 border-t border-neutral-800/50 flex flex-col gap-2.5">
        <Section
          title="Listen to"
          hint="Robert captures that app's whole audio output (Teams, Zoom, a browser tab…). Changing the app while running restarts capture."
        >
          <SelectField
            openKey="listen" openPicker={openPicker} setOpenPicker={setOpenPicker}
            className={FIELD + " flex-1 min-w-[180px]"}
            value={targetInList ? r.target : "__current"}
            onChange={(v) => { if (v !== "__current") r.setTarget(v); }}
            options={[
              ...(!targetInList ? [{ value: "__current", label: `${r.target} (not running now)` }] : []),
              ...apps.map((a) => ({ value: a.value, label: a.label })),
            ]}
          />
          <button onClick={r.refreshProcesses} className={BTN} title="Refresh the list of audio apps">
            ↻
          </button>
          {r.running && <span className="text-[10px] text-emerald-400">tapping {r.target}</span>}
          <label className="h-7 flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer ml-auto shrink-0" title="Start listening as soon as Robert opens">
            <input type="checkbox" checked={r.autoStart} onChange={(e) => r.setAutoStart(e.target.checked)} />
            auto-start
          </label>
        </Section>

        <Section
          title="Brain"
          hint="Local (default) runs fully on this machine through Ollama: no key, no cloud. Or bring your own key for DeepSeek, Claude, OpenAI, Groq, Gemini, OpenRouter, xAI, Mistral, or any OpenAI-compatible API. Audio is always transcribed on-device."
        >
          <SelectField
            openKey="brain" openPicker={openPicker} setOpenPicker={setOpenPicker}
            className={FIELD + " min-w-[170px]"}
            value={r.provider}
            onChange={(v) => r.setProvider(v as any)}
            options={[{ value: "local", label: "Local (Ollama)" }, ...CLOUD_PROVIDERS.map((p) => ({ value: p.id, label: p.label }))]}
          />
          {r.provider === "local" ? (
            <>
              <input
                value={r.localModel}
                onChange={(e) => r.setLocalModel(e.target.value)}
                placeholder="gemma4:12b"
                title="Ollama model. Picked for your RAM on first run: gemma4:12b with 16 GB or more, gemma4:e4b below."
                className={FIELD + " w-[130px]"}
              />
              {r.localStatus === null ? (
                <span className="text-[11px] text-neutral-500">checking…</span>
              ) : r.localStatus.running && r.localStatus.has_model ? (
                <span className="text-[11px] text-emerald-400 truncate">ready · {r.localModel}</span>
              ) : (
                <>
                  <span className="text-[11px] text-amber-400 truncate">
                    {!r.localStatus.installed
                      ? "Ollama not installed"
                      : !r.localStatus.running
                      ? "Ollama not running"
                      : `${r.localModel} not downloaded`}
                  </span>
                  {r.localSetup && !["done", "error"].includes(r.localSetup.stage) ? (
                    <button onClick={r.cancelLocalSetup} className={BTN} title="Stop the download; it resumes where it left off next time">
                      Cancel
                    </button>
                  ) : (
                    <button onClick={() => r.requestSetup("brain")} className={BTN} title="Installs Ollama if needed and downloads the model (7.5 GB for gemma4:12b, 3 GB for gemma4:e4b)">
                      Set up
                    </button>
                  )}
                </>
              )}
              <span className="basis-full flex items-center gap-2 text-[11px] text-neutral-400">
                <span className="text-[10px] text-neutral-600 uppercase tracking-wide">Vision (Solve screen)</span>
                <input
                  value={r.visionModel}
                  onChange={(e) => r.setVisionModel(e.target.value)}
                  placeholder="qwen2.5vl:7b"
                  title="A vision-capable Ollama model for Solve screen (reads a screenshot of a coding/technical problem). qwen2.5vl:7b ~6 GB."
                  className={FIELD + " w-[150px]"}
                />
                <button onClick={() => r.requestSetup("vision")} className={BTN} title="Download the vision model (about 6 GB for qwen2.5vl:7b)">
                  Set up vision
                </button>
              </span>
              {r.modelsLocation && (
                <span className="basis-full text-[10px] text-neutral-600 truncate" title={r.modelsLocation}>
                  Models stored in your Robert folder: {r.modelsLocation}
                </span>
              )}
            </>
          ) : (
            <>
              <input
                type="password"
                value={r.apiKey}
                onChange={(e) => r.setApiKey(e.target.value)}
                placeholder={`${CLOUD_PROVIDERS.find((p) => p.id === r.provider)?.label} key (${CLOUD_PROVIDERS.find((p) => p.id === r.provider)?.keyHint})`}
                className={FIELD + " flex-1 min-w-[160px]"}
              />
              <input
                value={r.model}
                onChange={(e) => r.setModel(e.target.value)}
                placeholder={`model: ${CLOUD_PROVIDERS.find((p) => p.id === r.provider)?.defaultModel}`}
                className={FIELD + " w-[170px]"}
              />
              <span className="basis-full text-[10px] text-neutral-600">
                Solve screen uses this same model — make sure it is vision-capable (GPT-4o, Claude, Gemini all are).
              </span>
            </>
          )}
          <button onClick={r.testBrain} disabled={r.brainTest.status === "testing"} className={BTN} title="Send a tiny test request to the selected brain">
            {r.brainTest.status === "testing" ? "Testing…" : "Test"}
          </button>
          {r.brainTest.status === "ok" && (
            <span className="text-[10px] text-emerald-400 basis-full">✓ key accepted, model replied: “{r.brainTest.detail}”</span>
          )}
          {r.brainTest.status === "fail" && (
            <span className="text-[10px] text-red-400 basis-full">✗ {r.brainTest.detail}</span>
          )}
          {r.provider === "custom" && (
            <input
              value={r.customBaseUrl}
              onChange={(e) => r.setCustomBaseUrl(e.target.value)}
              placeholder="custom base URL, OpenAI-compatible: https://api.example.com/v1"
              className={FIELD + " basis-full font-mono"}
            />
          )}
          {r.provider === "local" && r.localSetup && r.localSetup.stage !== "done" && (
            <div className="basis-full flex flex-col gap-0.5">
              <div className="h-1.5 w-full bg-neutral-800 rounded overflow-hidden">
                <div
                  className={`h-full ${r.localSetup.stage === "error" ? "bg-red-500" : "bg-emerald-500"}`}
                  style={{
                    width: r.localSetup.total
                      ? `${Math.min(100, Math.round((100 * r.localSetup.completed) / r.localSetup.total))}%`
                      : "8%",
                  }}
                />
              </div>
              <span className={`text-[10px] truncate ${r.localSetup.stage === "error" ? "text-red-400" : "text-neutral-500"}`}>
                {r.localSetup.status}
                {r.localSetup.total
                  ? ` · ${(r.localSetup.completed / 1e9).toFixed(1)} / ${(r.localSetup.total / 1e9).toFixed(1)} GB`
                  : ""}
              </span>
            </div>
          )}
        </Section>

        <Section
          title="Knowledge"
          hint="Your notes folder (any folder of Markdown; an Obsidian vault works). Pick one file for this meeting or leave Auto: robert-brief.md wins, otherwise all notes. Add file (or drop a file on this window): résumé, job description, agenda, handover… Robert rewrites it into a knowledge file, starting with your résumé as profile.md."
        >
          <input
            value={r.notesFolder}
            onChange={(e) => r.setNotesFolder(e.target.value)}
            placeholder="~/RobertNotes"
            title="Notes folder"
            className={FIELD + " w-[150px] font-mono"}
          />
          <SelectField
            openKey="knowledge" openPicker={openPicker} setOpenPicker={setOpenPicker}
            className={FIELD + " flex-1 min-w-[200px]"}
            value={r.notesList.includes(r.notesFile) ? r.notesFile : ""}
            onChange={(v) => r.setNotesFile(v)}
            options={[{ value: "", label: "Auto: robert-brief.md, else all notes" }, ...r.notesList.map((f) => ({ value: f, label: f }))]}
          />
          <button onClick={r.reloadGrounding} className={BTN} title="Reload notes and persona from the folder">
            Reload
          </button>
          <label className={BTN + " flex items-center cursor-pointer"} title="Add a résumé, job description, agenda, handover… (pdf, docx, txt, html, csv, md). Robert rewrites it into its knowledge format. You can also drop files onto this window.">
            Add file
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.text,.html,.htm,.csv,.md,.rtf,.json"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) r.uploadFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <span className="basis-full flex items-center gap-2 text-[10px] text-neutral-500">
            <span className="truncate">
              {r.notes
                ? `loaded ${r.groundingSource} (${r.notes.length.toLocaleString()} chars)`
                : "no meeting knowledge loaded yet"}
            </span>
            {r.notes && (
              <button onClick={() => setShowNotes((v) => !v)} className="shrink-0 text-neutral-400 hover:text-neutral-200 underline underline-offset-2">
                {showNotes ? "hide" : "view"}
              </button>
            )}
          </span>
          {showNotes && r.notes && (
            <textarea
              value={r.notes}
              readOnly
              rows={8}
              className="basis-full bg-neutral-900/40 border border-neutral-800 rounded px-2 py-1 text-xs outline-none font-mono resize-y text-neutral-400"
            />
          )}
          {r.inbox.map((f) => (
            <span key={f} className="basis-full flex items-center gap-2 text-[11px] text-neutral-400">
              <span className="truncate">
                {r.converting === f ? "converting" : "waiting"}: {f}
              </span>
              {r.converting !== f && (
                <button onClick={() => r.convertFile(f)} disabled={!!r.converting} className={BTN}>
                  Rewrite now
                </button>
              )}
            </span>
          ))}
          {r.convertStatus && (
            <span className={`basis-full text-[10px] ${r.convertStatus.startsWith("Could not") ? "text-red-400" : "text-neutral-500"}`}>
              {r.converting ? "⏳ " : ""}
              {r.convertStatus}
            </span>
          )}
        </Section>

        <Section
          title="Group calls"
          hint="With your name set, Robert knows when a question is yours, when it is a colleague's (it stays quiet), and when the floor is handed to you (it has your update ready). Call type Auto switches to group once two colleagues have been addressed by name."
        >
          <input
            value={r.myName}
            onChange={(e) => r.setMyName(e.target.value)}
            placeholder="your first name, plus how people mishear it: Alex, Alec"
            className={FIELD + " flex-1 min-w-[220px]"}
          />
          <SelectField
            openKey="calltype" openPicker={openPicker} setOpenPicker={setOpenPicker} className={FIELD + " min-w-[130px]"}
            value={r.callType}
            onChange={(v) => r.setCallType(v as any)}
            options={[{ value: "auto", label: "Call type: auto" }, { value: "one", label: "1:1 call" }, { value: "group", label: "group call" }]}
          />
        </Section>

        <Section
          title="Memory"
          hint="Recording logs the transcript locally and writes takeaways when you press Stop. What Robert learns in each meeting (your answers, facts, people, decisions) is always used in later answers; it lives in the notes folder as plain files."
        >
          <label className="h-7 flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={r.recordMeetings} onChange={(e) => r.setRecordMeetings(e.target.checked)} />
            record meetings (transcript + takeaways, local only)
          </label>
          {r.telemetryOn && (
            <label className="basis-full flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer" title="Anonymous usage and error events only — never transcripts, notes, meeting knowledge, names, or keys.">
              <input type="checkbox" checked={r.telemetryOn} onChange={(e) => r.setTelemetry(e.target.checked)} />
              share anonymous usage &amp; errors (no meeting content) — helps improve Robert
            </label>
          )}
        </Section>

        <Section
          title="Voice"
          hint="Robert's rules (how it answers, what it never does) are fixed by the app and always current. Only the VOICE is yours to change: pick up to 3 characters whose speaking style shapes how Robert talks. It is saved in _persona.md and used in every answer alongside your meeting knowledge."
        >
          <span className="h-7 flex items-center text-[11px] text-neutral-500">Rules: fixed by Robert</span>
          {r.personaCustomized && (
            <span className="h-5 px-1.5 rounded-full border border-sky-700 text-sky-300 text-[10px] flex items-center">hand-edited</span>
          )}
          <button onClick={() => r.setVoicePickerOpen(true)} className={BTN} title="Pick up to 3 anime characters whose style shapes how Robert talks">
            Choose voice
          </button>
          <button onClick={r.openPersona} className={BTN} title="Open the voice file to hand-tune it">
            Open
          </button>
          <button onClick={r.reloadPersona} className={BTN} title="Re-read the voice file after editing">
            Reload
          </button>
          <button onClick={r.resetPersona} className={BTN} title="Reset the voice to Robert's default and clear picks">
            Reset voice
          </button>
          <span className="basis-full text-[10px] text-neutral-500 truncate">
            {r.selectedVoices.length > 0
              ? "Voice: " + r.voices.filter((v) => r.selectedVoices.includes(v.id)).map((v) => v.label).join(" · ")
              : "Voice: Robert default"}
          </span>
        </Section>
      </div>
    </div>
  );
}
