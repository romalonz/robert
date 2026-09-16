// ─── Notes / retrieval / grounding (the context engine) ─────────────────────
// Per-turn retrieval pulls the most relevant paragraphs from every note; the
// grounding loaders assemble the meeting prompt from the notes folder (+ the
// meeting-memory block). Reusable by every skill. Moved verbatim out of the
// former robert.rs.
//
// resolve_notes_folder stays pub(crate): knowledge.rs references it as
// `crate::robert::resolve_notes_folder`, kept valid by the re-export in mod.rs.
// MEMORY_FILES / read_memory_block come from the meetings submodule.

use super::meetings::{read_memory_block, MEMORY_FILES};

// ─── Per-turn retrieval ──────────────────────────────────────────────────────
// For each question, pull the most relevant paragraphs from EVERY note in the
// folder (brief, handover docs, meeting takeaways, memory) into the prompt.
// Depth without prompt bloat: a few paragraphs, not whole files.

const STOPWORDS: [&str; 60] = [
    "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were", "have",
    "has", "had", "what", "when", "where", "which", "who", "why", "how", "does", "did", "will",
    "would", "could", "should", "can", "our", "their", "they", "them", "there", "here", "about",
    "from", "into", "than", "then", "also", "just", "like", "much", "many", "some", "any", "all",
    "not", "but", "its", "it's", "we're", "i'm", "don't", "doesn't", "is", "of", "to", "in", "on",
];

/// Light stemming so "costing"/"costs"/"cost" and "reports"/"reporting"/"report"
/// meet in the middle. Crude on purpose: fast, dependency-free, good enough
/// for paragraph ranking.
fn stem(w: &str) -> String {
    let mut s = w.to_string();
    for suf in ["ing", "ed", "es", "s"] {
        // keep at least 3 letters of stem ("costing" -> "cost", "asked" -> "ask")
        if s.len() >= 3 + suf.len() && s.ends_with(suf) && !(suf == "s" && s.ends_with("ss")) {
            s.truncate(s.len() - suf.len());
            break;
        }
    }
    s
}

fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '.' && c != ',')
        .map(|w| w.trim_matches(|c: char| c == '.' || c == ',' || c == '\''))
        .filter(|w| w.len() > 2 && !STOPWORDS.contains(w))
        .map(stem)
        .collect()
}

/// Split a note into paragraph-sized chunks (blank-line separated; bullet runs
/// stay together), each tagged with its nearest heading for context.
fn chunk_note(text: &str) -> Vec<(String, String)> {
    let mut chunks: Vec<(String, String)> = Vec::new();
    let mut heading = String::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, heading: &str, chunks: &mut Vec<(String, String)>| {
        let c = cur.trim();
        if c.len() > 30 {
            chunks.push((heading.to_string(), c.to_string()));
        }
        cur.clear();
    };
    for line in text.lines() {
        let l = line.trim_end();
        if l.starts_with('#') {
            flush(&mut cur, &heading, &mut chunks);
            heading = l.trim_start_matches('#').trim().to_string();
            continue;
        }
        if l.trim().is_empty() {
            flush(&mut cur, &heading, &mut chunks);
            continue;
        }
        cur.push_str(l);
        cur.push('\n');
        if cur.len() > 1200 {
            flush(&mut cur, &heading, &mut chunks);
        }
    }
    flush(&mut cur, &heading, &mut chunks);
    chunks
}

/// Rarity weight per query token: log((N+1)/(df+1)) + 1 over all chunks, so a
/// word that appears in one paragraph ("cost") outweighs one that appears in
/// most of them ("reporting").
fn idf_weights(query: &[String], chunk_token_sets: &[std::collections::HashSet<String>]) -> std::collections::HashMap<String, f32> {
    let n = chunk_token_sets.len().max(1) as f32;
    let mut w = std::collections::HashMap::new();
    for q in query {
        if w.contains_key(q) {
            continue;
        }
        let df = chunk_token_sets.iter().filter(|s| s.contains(q)).count() as f32;
        w.insert(q.clone(), ((n + 1.0) / (df + 1.0)).ln() + 1.0);
    }
    w
}

fn score_chunk(query: &[String], chunk: &str) -> f32 {
    // unweighted fallback (unit tests / single-chunk use); the real path uses
    // score_chunk_weighted with corpus IDF
    let set: std::collections::HashSet<String> = tokens(chunk).into_iter().collect();
    let w: std::collections::HashMap<String, f32> = query.iter().map(|q| (q.clone(), 1.0)).collect();
    score_chunk_weighted(query, &set, &w)
}

fn score_chunk_weighted(
    query: &[String],
    chunk_tokens: &std::collections::HashSet<String>,
    weights: &std::collections::HashMap<String, f32>,
) -> f32 {
    if query.is_empty() || chunk_tokens.is_empty() {
        return 0.0;
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0.0f32;
    let mut hit = 0.0f32;
    let mut num_hits = 0usize;
    for q in query {
        if !seen.insert(q.as_str()) {
            continue;
        }
        let w = *weights.get(q).unwrap_or(&1.0);
        total += w;
        if chunk_tokens.contains(q) {
            hit += w;
            if q.chars().any(|c| c.is_ascii_digit()) {
                num_hits += 1;
            }
        }
    }
    if hit == 0.0 || total == 0.0 {
        return 0.0;
    }
    // weighted coverage of the question, small bonus for numbers, mild length penalty
    hit / total + 0.3 * num_hits as f32 - (chunk_tokens.len() as f32 / 4000.0)
}

/// Top-k relevant paragraphs across all notes for `query`, formatted for the prompt.
#[tauri::command]
pub fn robert_retrieve_notes(
    notes_folder: Option<String>,
    query: String,
    max_chars: Option<usize>,
    prefer: Option<String>,
) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let q = tokens(&query);
    if q.is_empty() {
        return Ok(String::new());
    }
    let mut files = Vec::new();
    gather_md(&base, &base, &mut files); // skips meetings/ and memory/; memory rides separately
    // memory files are worth searching too
    for name in MEMORY_FILES {
        if let Ok(c) = std::fs::read_to_string(base.join("memory").join(name)) {
            files.push((std::time::SystemTime::UNIX_EPOCH, format!("memory/{}", name), c));
        }
    }
    // chunk everything once, compute corpus rarity weights, then score.
    // A heading that matches the question is the strongest signal we have
    // (headings summarize), so heading hits earn a boost on top of coverage.
    struct C { rel: String, text: String, set: std::collections::HashSet<String>, head: std::collections::HashSet<String> }
    let mut chunks: Vec<C> = Vec::new();
    for (_, rel, content) in &files {
        for (heading, body) in chunk_note(content) {
            let text = if heading.is_empty() { body.clone() } else { format!("{}\n{}", heading, body) };
            let set: std::collections::HashSet<String> = tokens(&text).into_iter().collect();
            let head: std::collections::HashSet<String> = tokens(&heading).into_iter().collect();
            chunks.push(C { rel: rel.clone(), text, set, head });
        }
    }
    let sets: Vec<std::collections::HashSet<String>> = chunks.iter().map(|c| c.set.clone()).collect();
    let weights = idf_weights(&q, &sets);
    let mut scored: Vec<(f32, String, String)> = Vec::new();
    for c in chunks {
        let mut sc = score_chunk_weighted(&q, &c.set, &weights);
        if sc > 0.34 {
            let head_hits = q.iter().filter(|t| c.head.contains(t.as_str())).count();
            if head_hits > 0 {
                sc += 0.5 * (head_hits as f32 / q.len().max(1) as f32);
            }
            // the note selected for THIS meeting outranks unrelated notes
            if let Some(pref) = prefer.as_deref().filter(|p| !p.is_empty()) {
                if c.rel == pref {
                    sc += 0.3;
                }
            }
            scored.push((sc, c.rel, c.text));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let cap = max_chars.unwrap_or(2200);
    let mut out = String::new();
    // Diversify: at most one chunk per (file, heading), so the model gets VARIED
    // material — different projects/sections — instead of the same story twice.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (_, rel, ch) in scored.into_iter().take(12) {
        let head = ch.lines().next().unwrap_or("").trim().to_lowercase();
        if !seen.insert(format!("{}|{}", rel, head)) {
            continue;
        }
        let block = format!("### {}\n{}\n\n", rel, ch.trim());
        if out.len() + block.len() > cap {
            break;
        }
        out.push_str(&block);
    }
    Ok(out.trim().to_string())
}

/// True if this machine is already set up (has a profile or any real knowledge
/// file), so onboarding never runs on a configured machine — only on a fresh
/// install with an empty notes folder.
#[tauri::command]
pub fn robert_is_configured(notes_folder: Option<String>) -> bool {
    let Ok((_, base)) = resolve_notes_folder(notes_folder) else { return false };
    if base.join("profile.md").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(&base) else { return false };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let low = name.to_lowercase();
        if low.ends_with(".md")
            && !name.starts_with('_')
            && !low.eq("readme.md")
            && (low.starts_with("robert-knowledge_") || low.starts_with("robert-brief"))
        {
            return true;
        }
    }
    false
}

/// Read one top-level file from the notes folder (persona, a note). None when absent.
#[tauri::command]
pub fn robert_read_note(notes_folder: Option<String>, name: String) -> Result<Option<String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if safe.starts_with('.') || safe.contains("..") {
        return Err("invalid note name".into());
    }
    let p = base.join(&safe);
    if !p.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

/// Absolute path of a top-level notes file (for "Open" buttons).
#[tauri::command]
pub fn robert_note_path(notes_folder: Option<String>, name: String) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    // sanitize to a bare filename: no path separators, no traversal, no absolute
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if safe.is_empty() || safe.starts_with('.') || safe.contains("..") {
        return Err("invalid note name".into());
    }
    Ok(base.join(&safe).to_string_lossy().to_string())
}

/// Write a top-level note into the notes folder (e.g. meeting takeaways), so
/// it shows up in the Meeting knowledge picker like any other note.
#[tauri::command]
pub fn robert_write_note(notes_folder: Option<String>, name: String, content: String) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if !safe.ends_with(".md") || safe.starts_with('.') || safe.eq_ignore_ascii_case("readme.md") {
        return Err("invalid note name".into());
    }
    std::fs::write(base.join(&safe), content).map_err(|e| e.to_string())?;
    Ok(safe)
}

#[cfg(test)]
mod retrieval_tests {
    use super::*;

    #[test]
    fn picks_the_paragraph_that_answers_the_question() {
        let note = "# Handover\n\nSeven reports are built on the VDI from Epicor BAQ extracts.\n\n## Paths\nEverything publishes to the BWF Insights folder; the [DEV] brackets need -LiteralPath in PowerShell.\n\n## Cargo tracking\nContainer ETAs come from the Vizion API via Playwright, written to Cargo_Tracking_Report.xlsx.\n";
        let chunks: Vec<String> = chunk_note(note).into_iter().map(|(h, b)| format!("{}\n{}", h, b)).collect();
        assert_eq!(chunks.len(), 3);
        let q = tokens("where do the container ETAs come from?");
        let mut best = chunks.iter().map(|c| (score_chunk(&q, c), c.clone())).collect::<Vec<_>>();
        best.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        assert!(best[0].1.contains("Vizion"), "got {:?}", best[0]);
        assert!(best[0].0 > 0.34);
    }

    #[test]
    fn unrelated_paragraphs_score_zero() {
        let q = tokens("what does the snapshot retention look like?");
        assert_eq!(score_chunk(&q, "Good morning everyone, thanks for joining."), 0.0);
    }
}

#[derive(serde::Serialize)]
pub struct Grounding {
    source: String,
    content: String,
}

// Keep the concatenated notes small enough that per-turn prompt evaluation
// stays interactive on the local brain (~24K chars ≈ 7-8K tokens).
const NOTES_CHAR_CAP: usize = 24_000;

/// Recursively collect .md files under `dir` (hidden entries and README.md
/// skipped), returning (mtime, relative path, content).
fn gather_md(
    dir: &std::path::Path,
    base: &std::path::Path,
    out: &mut Vec<(std::time::SystemTime, String, String)>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            // meetings/ and memory/ are Meeting Memory's own folders: summaries
            // are offered individually in the picker, memory is injected with
            // its own cap. Neither belongs in the all-notes concatenation.
            if p.parent() == Some(base) && (name == "meetings" || name == "memory" || name == "sources") {
                continue;
            }
            gather_md(&p, base, out);
            continue;
        }
        // files starting with "_" are Robert's own (templates, persona), not knowledge
        if !name.to_lowercase().ends_with(".md")
            || name.eq_ignore_ascii_case("readme.md")
            || name.starts_with('_')
        {
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > 2_000_000 {
            continue;
        }
        if let Ok(c) = std::fs::read_to_string(&p) {
            let c = c.trim().to_string();
            if c.is_empty() {
                continue;
            }
            let rel = p
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or(name);
            let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            out.push((mtime, rel, c));
        }
    }
}

const NOTES_README: &str = "# RobertNotes\n\nThis folder is Robert's knowledge. Every .md file here becomes meeting grounding.\n\n- Pick a specific file in the app's \"Meeting knowledge source\" dropdown, or leave it on Auto.\n- Auto: a file named robert-brief.md wins when present; otherwise all .md files load, newest first.\n- Keep files small and factual; exact numbers get quoted verbatim in answers.\n- This README is ignored. An Obsidian vault works too: point the app's Notes folder setting at it.\n";

pub(crate) fn resolve_notes_folder(notes_folder: Option<String>) -> Result<(String, std::path::PathBuf), String> {
    // HOME on macOS/Linux, USERPROFILE on Windows
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home directory found".to_string())?;
    let folder = notes_folder
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "~/RobertNotes".into())
        .replacen('~', &home, 1);
    let base = std::path::PathBuf::from(&folder);
    // First run: create the folder and seed a README explaining how it works,
    // so users can find it and drop notes in without reading any docs.
    if !base.exists() {
        let _ = std::fs::create_dir_all(&base);
        let _ = std::fs::write(base.join("README.md"), NOTES_README);
    }
    // spec templates ride along (idempotent; ignored by grounding)
    crate::knowledge::ensure_templates(&base);
    Ok((folder, base))
}

/// List the .md files in the notes folder (relative paths, newest first) so
/// the UI can offer them as selectable meeting-knowledge sources.
#[tauri::command]
pub fn robert_list_notes(notes_folder: Option<String>) -> Result<Vec<String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let mut notes = Vec::new();
    gather_md(&base, &base, &mut notes);
    notes.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    let mut rels: Vec<String> = notes.into_iter().map(|(_, rel, _)| rel).collect();
    // stable sort: the brief bubbles to the top, the rest stay newest-first
    rels.sort_by_key(|r| if r == "robert-brief.md" { 0 } else { 1 });
    Ok(rels)
}

/// Load grounding. Priority:
/// 1. An explicitly selected note file (`notes_file`, relative to the folder).
/// 2. `<notes folder>/robert-brief.md` — the distilled prep for THE meeting.
/// 3. All .md files in the notes folder (an Obsidian vault works as-is;
///    Notion pages arrive via Markdown export), newest first, size-capped.
#[tauri::command]
pub fn robert_load_grounding(
    notes_folder: Option<String>,
    notes_file: Option<String>,
    use_memory: Option<bool>,
) -> Result<Grounding, String> {
    let (folder, base) = resolve_notes_folder(notes_folder)?;
    let g = load_grounding_inner(&folder, &base, notes_file);
    // Meeting Memory: what Robert learned from past meetings rides along with
    // any grounding, capped so per-turn latency stays flat.
    if use_memory.unwrap_or(true) {
        let mem = read_memory_block(&base);
        if !mem.is_empty() {
            return Ok(match g {
                Ok(mut g) => {
                    g.content.push_str("\n\n## MEMORY (learned from my past meetings)\n\n");
                    g.content.push_str(&mem);
                    g.source.push_str(" + memory");
                    g
                }
                Err(_) => Grounding { source: format!("memory only in {}", folder), content: mem },
            });
        }
    }
    g
}

fn load_grounding_inner(
    folder: &str,
    base: &std::path::Path,
    notes_file: Option<String>,
) -> Result<Grounding, String> {
    let folder = folder.to_string();
    let base = base.to_path_buf();

    // explicit selection wins; sanitized to stay inside the folder
    if let Some(sel) = notes_file.filter(|s| !s.trim().is_empty()) {
        let sel = sel.trim().to_string();
        if !sel.contains("..") && !sel.starts_with('/') {
            if let Ok(c) = std::fs::read_to_string(base.join(&sel)) {
                let c = c.trim().to_string();
                if !c.is_empty() {
                    return Ok(Grounding {
                        source: format!("{} (selected) in {}", sel, folder),
                        content: c,
                    });
                }
            }
        }
        // selected file gone or empty: fall through to auto
    }

    let brief = base.join("robert-brief.md");
    if let Ok(c) = std::fs::read_to_string(&brief) {
        let c = c.trim().to_string();
        if !c.is_empty() {
            return Ok(Grounding {
                source: format!("robert-brief.md (meeting brief) in {}", folder),
                content: c,
            });
        }
    }

    let mut notes = Vec::new();
    gather_md(&base, &base, &mut notes);
    if !notes.is_empty() {
        notes.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
        let mut content = String::new();
        let mut used = 0usize;
        for (_, rel, c) in &notes {
            let block = format!("### {}\n{}\n\n", rel, c);
            if content.len() + block.len() > NOTES_CHAR_CAP {
                if content.is_empty() {
                    content.push_str(&block[..NOTES_CHAR_CAP.min(block.len())]);
                    used = 1;
                }
                break;
            }
            content.push_str(&block);
            used += 1;
        }
        return Ok(Grounding {
            source: format!("{} note file(s) in {}", used, folder),
            content: content.trim().to_string(),
        });
    }

    Err(format!(
        "No .md notes found in {} — drop your notes there (or point the setting at an Obsidian vault).",
        folder
    ))
}
#[cfg(test)]
mod retrieval_live_probe {
    // Prints what retrieval pulls from the REAL notes folder for a few
    // questions. Run: cargo test retrieval_live_probe -- --nocapture --ignored
    #[test]
    #[ignore]
    fn probe_real_notes() {
        for q in [
            "where do the container ETAs for cargo tracking come from?",
            "what is the gotcha with the reports folder path in PowerShell?",
            "how much is this costing us?",
        ] {
            let out = super::robert_retrieve_notes(None, q.to_string(), Some(1400), Some("robert-brief.md".into())).unwrap();
            println!("\n=== Q: {} ===\n{}\n", q, out);
        }
    }
}
