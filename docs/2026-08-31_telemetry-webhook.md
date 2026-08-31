# Operator telemetry webhook (personal analytics)

Robert can POST **anonymous** usage + error events to a webhook you own, so you
can watch adoption and errors across users. It is OFF by default and ships off
in the public build.

## Turn it on (your builds only)
Set your webhook URL one of two ways:
- **Env var (recommended, keeps it out of the repo):** build/run with
  `ROBERT_TELEMETRY_URL=https://your-hook.example/ingest`. In GitHub Actions,
  add it as a secret and export it in the build step, or bake it with
  `option_env!` at compile time.
- **Constant:** paste it into `DEFAULT_WEBHOOK` in `src-tauri/src/telemetry.rs`
  and rebuild. Empty string = telemetry fully disabled.

## What it sends (and never sends)
POST JSON body:
```json
{
  "install_id": "<random uuid, created once per machine, not tied to identity>",
  "event": "meeting_start",
  "props": { "provider": "local", "mode": "auto" },
  "app_version": "0.1.9",
  "os": "windows",
  "arch": "x86_64",
  "ts": 1788000000
}
```
Events currently emitted:
- `app_open` `{provider}`
- `meeting_start` `{provider, mode}`
- `meeting_end` `{turns, answers}`  (counts only)
- `solve_screen` `{ok, provider}`
- `error` `{where, msg}`  (msg truncated to 200 chars)

**Never sent:** transcripts, notes, meeting knowledge, résumé/profile text,
attendee/colleague names, API keys, file contents. String props are truncated
to 200 chars server-side-of-the-app so a stray value cannot smuggle content.

## User control / disclosure
- Users on a build with telemetry configured see a settings checkbox
  ("share anonymous usage & errors") and can opt out; opting out writes a
  `telemetry_off` marker in the Robert data folder. `ROBERT_TELEMETRY=0` also
  disables it.
- Because Robert is marketed as local-first, DISCLOSE this in your README/privacy
  note if you enable it. It is the one thing that phones home.

## Receiving end (your future work)
Any HTTPS endpoint that accepts a JSON POST works: a serverless function, a
Cloudflare Worker, a Zapier/Make catch hook, a self-hosted collector, or route
it into PostHog/an analytics DB. The `install_id` lets you count unique users
and sessions without any PII.
