// ─── Meeting Memory ──────────────────────────────────────────────────────────
// Fathom-like, fully local. One folder per meeting under <notes>/meetings/,
// plain files only: transcript.jsonl (source of truth), transcript.md,
// summary.md. Learned knowledge lives in <notes>/memory/*.md and is injected
// into grounding (capped). Design: docs/2026-08-28_meeting-memory-plan.md
//
// Moved verbatim out of the former robert.rs. The memory-file catalog
// (MEMORY_FILES) and read_memory_block are pub(crate) because notes_ctx's
// retrieval + grounding loaders consume them.

use super::notes_ctx::resolve_notes_folder;

pub(crate) const MEMORY_FILES: [&str; 4] = ["qa-bank.md", "facts.md", "people.md", "decisions.md"];
const MEMORY_CHAR_CAP: usize = 8_000;

#[derive(serde::Serialize)]
pub struct MeetingInfo {
    id: String,
    dir: String,
    started: String,
    target: String,
    turns: u64,
    has_summary: bool,
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').chars().take(40).collect()
}

fn meetings_root(notes_folder: Option<String>) -> Result<std::path::PathBuf, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let root = base.join("meetings");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// A meeting dir is only valid if it is a direct child of <notes>/meetings.
fn checked_meeting_dir(notes_folder: Option<String>, dir: &str) -> Result<std::path::PathBuf, String> {
    let root = meetings_root(notes_folder)?;
    let p = std::path::PathBuf::from(dir);
    let ok = p.parent() == Some(root.as_path())
        && p.file_name().map(|n| !n.to_string_lossy().starts_with('.')).unwrap_or(false);
    if !ok {
        return Err("meeting folder is outside the notes folder".into());
    }
    Ok(p)
}

/// Memory files concatenated for grounding, head-first (entries are kept
/// newest-first by the merge step), capped.
pub(crate) fn read_memory_block(base: &std::path::Path) -> String {
    let mut out = String::new();
    for name in MEMORY_FILES {
        if let Ok(c) = std::fs::read_to_string(base.join("memory").join(name)) {
            let c = c.trim();
            if c.is_empty() {
                continue;
            }
            let block = format!("### memory/{}\n{}\n\n", name, c);
            if out.len() + block.len() > MEMORY_CHAR_CAP {
                let room = MEMORY_CHAR_CAP.saturating_sub(out.len());
                if room > 200 {
                    let cut: String = block.chars().take(room).collect();
                    out.push_str(&cut);
                }
                break;
            }
            out.push_str(&block);
        }
    }
    out.trim().to_string()
}

fn render_transcript_md(jsonl: &str) -> (String, u64) {
    let mut md = String::new();
    let mut turns: u64 = 0;
    for line in jsonl.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("header") {
            md.push_str(&format!(
                "# Meeting transcript\n\nStarted: {}  \nApp: {}  \nMode: {}  \nBrain: {}\n\n---\n\n",
                v.get("iso").and_then(|x| x.as_str()).unwrap_or(""),
                v.get("target").and_then(|x| x.as_str()).unwrap_or(""),
                v.get("mode").and_then(|x| x.as_str()).unwrap_or(""),
                v.get("brain").and_then(|x| x.as_str()).unwrap_or("")
            ));
            continue;
        }
        let t = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
        let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let who = match v.get("who").and_then(|x| x.as_str()).unwrap_or("") {
            "them" => {
                turns += 1;
                "Them".to_string()
            }
            "me" => "Me".to_string(),
            "robert" => "Robert (suggested)".to_string(),
            other => other.to_string(),
        };
        md.push_str(&format!("[{}] {}: {}\n", t, who, text));
    }
    (md, turns)
}

#[tauri::command]
pub fn robert_meeting_begin(
    notes_folder: Option<String>,
    target: String,
    mode: String,
    brain: String,
    started: String,
    iso: String,
) -> Result<String, String> {
    let root = meetings_root(notes_folder)?;
    let id = format!("{}_{}", slug(&started), slug(&target));
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let header = serde_json::json!({
        "type": "header", "iso": iso, "target": target, "mode": mode, "brain": brain
    });
    std::fs::write(dir.join("transcript.jsonl"), format!("{}\n", header))
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn robert_meeting_append(
    notes_folder: Option<String>,
    dir: String,
    line: String,
) -> Result<(), String> {
    use std::io::Write;
    let d = checked_meeting_dir(notes_folder, &dir)?;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(d.join("transcript.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line.trim()).map_err(|e| e.to_string())
}

/// Render transcript.md from the JSONL log. Returns (markdown, turns heard).
#[tauri::command]
pub fn robert_meeting_finish(
    notes_folder: Option<String>,
    dir: String,
) -> Result<(String, u64), String> {
    let d = checked_meeting_dir(notes_folder, &dir)?;
    let jsonl = std::fs::read_to_string(d.join("transcript.jsonl")).map_err(|e| e.to_string())?;
    let (md, turns) = render_transcript_md(&jsonl);
    std::fs::write(d.join("transcript.md"), &md).map_err(|e| e.to_string())?;
    Ok((md, turns))
}

#[tauri::command]
pub fn robert_meeting_write(
    notes_folder: Option<String>,
    dir: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let d = checked_meeting_dir(notes_folder, &dir)?;
    if !name.ends_with(".md") || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("invalid file name".into());
    }
    std::fs::write(d.join(name), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn robert_read_memory(notes_folder: Option<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let mut m = std::collections::HashMap::new();
    for name in MEMORY_FILES {
        m.insert(
            name.to_string(),
            std::fs::read_to_string(base.join("memory").join(name)).unwrap_or_default(),
        );
    }
    Ok(m)
}

#[tauri::command]
pub fn robert_write_memory(notes_folder: Option<String>, name: String, content: String) -> Result<(), String> {
    if !MEMORY_FILES.contains(&name.as_str()) {
        return Err("unknown memory file".into());
    }
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let dir = base.join("memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(name), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn robert_list_meetings(notes_folder: Option<String>) -> Result<Vec<MeetingInfo>, String> {
    let root = meetings_root(notes_folder)?;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            if id.starts_with('.') {
                continue;
            }
            let jsonl = std::fs::read_to_string(p.join("transcript.jsonl")).unwrap_or_default();
            let (mut started, mut target) = (String::new(), String::new());
            if let Some(first) = jsonl.lines().next() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(first) {
                    started = v.get("iso").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    target = v.get("target").and_then(|x| x.as_str()).unwrap_or("").to_string();
                }
            }
            let (_, turns) = render_transcript_md(&jsonl);
            out.push(MeetingInfo {
                id,
                dir: p.to_string_lossy().to_string(),
                started,
                target,
                turns,
                has_summary: p.join("summary.md").exists(),
            });
        }
    }
    out.sort_by(|a, b| b.id.cmp(&a.id)); // ids start with the timestamp: newest first
    Ok(out)
}

#[tauri::command]
pub fn robert_delete_meeting(notes_folder: Option<String>, dir: String) -> Result<(), String> {
    let d = checked_meeting_dir(notes_folder, &dir)?;
    std::fs::remove_dir_all(d).map_err(|e| e.to_string())
}

#[cfg(test)]
mod meeting_tests {
    use super::*;

    #[test]
    fn slug_is_filesystem_safe() {
        assert_eq!(slug("com.microsoft.teams2"), "com-microsoft-teams2");
        assert_eq!(slug("2026-08-28_1430"), "2026-08-28-1430");
        assert_eq!(slug("  weird//name!! "), "weird-name");
    }

    #[test]
    fn transcript_renders_and_counts_turns() {
        let jsonl = concat!(
            r#"{"type":"header","iso":"2026-08-28T14:30:00Z","target":"teams","mode":"auto","brain":"local"}"#, "\n",
            r#"{"t":"14:30:05","who":"them","text":"How much does this cost?"}"#, "\n",
            r#"{"t":"14:30:06","who":"robert","text":"Zero new spend."}"#, "\n",
            r#"{"t":"14:30:09","who":"me","text":"Zero new spend, we use what we have.","delivered":true}"#, "\n",
            r#"{"t":"14:30:20","who":"them","text":"And who maintains it?"}"#, "\n",
            "not json\n"
        );
        let (md, turns) = render_transcript_md(jsonl);
        assert_eq!(turns, 2);
        assert!(md.contains("# Meeting transcript"));
        assert!(md.contains("[14:30:05] Them: How much does this cost?"));
        assert!(md.contains("[14:30:06] Robert (suggested): Zero new spend."));
        assert!(md.contains("[14:30:09] Me: Zero new spend, we use what we have."));
    }
}
