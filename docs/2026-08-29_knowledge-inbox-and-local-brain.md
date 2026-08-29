# Knowledge inbox and one-click local brain (2026-08-29)

## Why the model is not inside the installer
gemma4:12b is about 7.5 GB. GitHub caps release assets at 2 GB and repository
files at 100 MB, so neither the `.exe` nor the repo can carry it. The consumer
experience is delivered instead by `src-tauri/src/local_brain.rs`:
`robert_local_status` (is Ollama installed / running, is the model present, via
`/api/tags`) and `robert_setup_local` (download the Ollama installer and run it
silently on Windows, unpack the app bundle on macOS, start it, then stream
`/api/pull` progress as `robert://local` events). The settings panel shows the
status and a progress bar; one click, no terminal.

## Knowledge inbox
`src-tauri/src/knowledge.rs`
- `robert_import_file` (drag-drop paths) and `robert_import_bytes` (in-app
  picker, base64) copy a file into the notes folder.
- `robert_list_inbox` lists convertible files (pdf, docx, txt, html, csv, rtf,
  json) at the top level.
- `robert_extract_text`: pdf via `pdf-extract`, docx via `zip` + tag stripping,
  html tag stripping, text as is. Capped at 60K characters.
- `robert_find_profile`: `profile*.md` / `*resume*.md` / `*cv*.md` for mapping.
- `robert_archive_source`: moves the source to `sources/` after conversion.
- `ensure_templates` seeds `_TEMPLATE_interview-knowledge.md` and
  `_TEMPLATE_meeting-brief.md`; grounding skips `_TEMPLATE*` and `sources/`.

Frontend (`useRobert.ts`): `convertFile` = extract -> `CONVERT_SYSTEM` (decides
job description vs everything else, emits the matching section set, maps every
JD requirement to the profile with "Bridge:" for related experience, quotes
numbers verbatim, under 12K characters) -> `robert_write_note` as
`robert-knowledge_<slug>.md` or `robert-brief_<slug>.md` -> archive source ->
reload -> select. `autoConvert` (default on) converts whatever the inbox holds,
one file at a time. Drag-drop uses `getCurrentWebview().onDragDropEvent`.

Measured: Innova JD (3.4K chars) + profile (11.7K) -> 9K-char file with all
sections in 55 s on gemma4:12b (M-series Mac).

## Done-for-you hardening (same day)
- Auto-setup: with Brain = Local and the model not ready, `setupLocalBrain`
  starts by itself once per launch; Cancel (`robert_local_cancel`) stops the
  download or pull; Ollama resumes partial pulls on the next attempt.
- Model choice by RAM (`robert_local_recommend`): >= 15 GB -> gemma4:12b, else
  gemma4:e4b; applied once unless the user typed a model.
- Windows: `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, falling back to the
  visible wizard if the silent run fails or leaves no `ollama.exe`; the server
  is started without a console window. macOS: the unpacked app is opened by
  path. One automatic pull retry.
- Proof on real Windows: the `ollama-silent-install-probe` job in
  `.github/workflows/windows.yml` downloads the installer, installs silently,
  asserts `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, starts the server, and
  pulls a small model through `/api/pull`.

## Résumé as the standing reference
- A résumé/CV converts to `profile.md` (type C in `CONVERT_SYSTEM`: every role,
  date, number kept). `robert_find_profile` returns `profile.md` first.
- The inbox converts résumé-like files before anything else.
- Job descriptions map every requirement to the profile and end with a
  `## Sources` section naming both files; without a profile the section says so
  and the file is marked for rebuild.
- When a profile is created, `robert_list_unprofiled` finds knowledge files
  carrying "Profile: none" and `convertFile(src, {fromSources, replaces})`
  rebuilds each from `sources/`.

## Persona as a file (same day)
`_persona.md` in the notes folder replaces the settings textarea. `loadPersona`
(called by `reloadGrounding`) seeds it with `DEFAULT_GROUNDING`, re-reads it,
and keeps following app updates while the file still equals the default it was
written from (`robert.personaBase`). Settings row: Open (default editor via
`robert_open_path`), Reload, Reset to default. Grounding skips every `_*.md`.
