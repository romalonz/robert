//! Knowledge inbox: any file a user drops into RobertNotes (or uploads in the
//! app) gets its text extracted here, rewritten into Robert's Markdown spec by
//! the brain (frontend), saved as a .md next to the other notes, and the
//! source parked in `sources/`. Also seeds the spec templates on first run.

use std::path::{Path, PathBuf};

use base64::Engine;

use crate::robert::resolve_notes_folder;

/// Extensions the inbox knows how to read.
pub const CONVERTIBLE_EXTS: &[&str] = &["pdf", "docx", "txt", "text", "html", "htm", "csv", "rtf", "json"];

#[derive(serde::Serialize)]
pub struct Extracted {
    pub file: String,
    pub kind: String,
    pub chars: usize,
    pub truncated: bool,
    pub text: String,
}

const MAX_CHARS: usize = 60_000;

pub const TEMPLATE_INTERVIEW: &str = r###"# Template: interview knowledge file (copy, fill, rename to robert-knowledge_<role>.md)
Everything under a "##" heading is retrievable on its own, so keep headings specific. Delete this first line when you fill it in. Files starting with _TEMPLATE are ignored by Robert.

## Answer format
- Start with ONE short explainer sentence in plain prose (no bullet), then the bullets.
- Default: at most 400 characters in total, 2 to 3 short bullets, each one a fact, number, or claim I can say out loud.
- Narrative questions (walk me through, tell me about yourself, employment history, career path, end to end, give me an example): up to 900 characters, 4 to 6 bullets in time order, each with one number or name.

## The role in one line
<what the job is, in one sentence>

## My opening pitch (if asked "tell me about yourself")
- <three bullets: years and craft, the proof, the rule I work by>

## JD requirements mapped to my experience (bridge = related, not identical)
### <requirement 1 from the job description>
- <my direct experience with numbers, or "Bridge:" plus the closest related experience>
### <requirement 2>
- ...

## What I do today
- <current role, in plain terms, numbers I can state>

## Employment highlights (numbers as on my profile)
- <role, company, dates: one line each with one number>

## Projects and freelance work
- <client or project, dates, what I built, one number>

## The company (researched; say "as I understand it")
- <what they sell, size, customers, where they are, why this role exists>

## A day in this job
- <the daily rhythm of the role, the weekly and monthly cadence, what a bad day looks like>

## Likely questions and my bullets
### <question 1>
- <two bullets I would say>
### <question 2>
- ...

## 30-60-90
- 30 days: ...
- 60 days: ...
- 90 days: ...

## Questions I can ask them
- <four questions, one sentence each>

## Hard rules for my answers
- Never claim hands-on experience I do not have; bridge to related work instead.
- Quote my numbers exactly as written above; if a number is not here, say I will confirm it.
- When they ask "any questions for me?", never say no; pick one from the list above.
"###;

pub const TEMPLATE_BRIEF: &str = r###"# Template: meeting brief (copy, fill, save as robert-brief.md for THE meeting, or robert-knowledge_<topic>.md)
Robert grounds on robert-brief.md first when it exists. Keep it compact (2 to 6K characters): only validated facts, exact numbers, plain English. Files starting with _TEMPLATE are ignored by Robert.

## Who is in the room and the tone to hold
- <names, roles, what each cares about, how they push>
- Tone: <calm, factual, no timelines, never blame anyone>

## What I am presenting
- <the deliverable in plain terms, one paragraph>

## Numbers I can state with confidence
- <each number exactly as it should be spoken, with its cross-check>

## Design decisions phrased as defenses
- Why <decision>: <one-line reason>

## Security, cost, and anything already disclosed
- <stated plainly so it can never be a gotcha>

## Likely challenges and my one-line answers
### <challenge 1, in their words>
- <my answer, one or two sentences>
### <challenge 2>
- ...

## Hard rules for my answers
- First person, speakable, no timelines or time estimates, never blame anyone.
- If a specific is not in this file, say I will confirm it rather than inventing it.
"###;

/// Seed the spec templates (idempotent, never overwrites).
pub fn ensure_templates(base: &Path) {
    let t1 = base.join("_TEMPLATE_interview-knowledge.md");
    if !t1.exists() {
        let _ = std::fs::write(t1, TEMPLATE_INTERVIEW);
    }
    let t2 = base.join("_TEMPLATE_meeting-brief.md");
    if !t2.exists() {
        let _ = std::fs::write(t2, TEMPLATE_BRIEF);
    }
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn safe_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    base.chars()
        .map(|c| if c.is_ascii_alphanumeric() || " -_.()".contains(c) { c } else { '-' })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Files waiting in the inbox: convertible, top-level, not hidden.
#[tauri::command]
pub fn robert_list_inbox(notes_folder: Option<String>) -> Result<Vec<String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        if CONVERTIBLE_EXTS.contains(&ext_of(&name).as_str()) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// Copy an external file (drag-drop) into the notes folder. Returns its name.
#[tauri::command]
pub fn robert_import_file(notes_folder: Option<String>, path: String) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("not a file".into());
    }
    let name = safe_file_name(&path);
    let ext = ext_of(&name);
    if !CONVERTIBLE_EXTS.contains(&ext.as_str()) && ext != "md" {
        return Err(format!("unsupported file type .{ext} (use pdf, docx, txt, html, csv, or md)"));
    }
    let dest = base.join(&name);
    if src.canonicalize().ok() == dest.canonicalize().ok() {
        return Ok(name);
    }
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Save uploaded bytes (from the in-app file picker) into the notes folder.
#[tauri::command]
pub fn robert_import_bytes(
    notes_folder: Option<String>,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let name = safe_file_name(&name);
    let ext = ext_of(&name);
    if !CONVERTIBLE_EXTS.contains(&ext.as_str()) && ext != "md" {
        return Err(format!("unsupported file type .{ext} (use pdf, docx, txt, html, csv, or md)"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    if bytes.len() > 50_000_000 {
        return Err("file too large (50 MB max)".into());
    }
    std::fs::write(base.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Move a converted source into sources/ so it is not offered again.
#[tauri::command]
pub fn robert_archive_source(notes_folder: Option<String>, file: String) -> Result<(), String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let name = safe_file_name(&file);
    let src = base.join(&name);
    if !src.is_file() {
        return Err("source not found".into());
    }
    let dir = base.join("sources");
    let _ = std::fs::create_dir_all(&dir);
    std::fs::rename(&src, dir.join(&name)).map_err(|e| e.to_string())
}

/// The user's profile note, if they keep one (profile*.md, *resume*.md,
/// *cv*.md), so a converted job description can be mapped to real experience.
#[tauri::command]
pub fn robert_find_profile(notes_folder: Option<String>) -> Result<Option<String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if !name.ends_with(".md") || name.starts_with('_') {
            continue;
        }
        if name.starts_with("profile") || name.contains("resume") || name.contains("-cv") || name == "cv.md" {
            if let Ok(c) = std::fs::read_to_string(e.path()) {
                let mut c = c.trim().to_string();
                if c.len() > 12_000 {
                    c.truncate(12_000);
                }
                return Ok(Some(c));
            }
        }
    }
    Ok(None)
}

/// Plain text of one inbox file.
#[tauri::command]
pub fn robert_extract_text(notes_folder: Option<String>, file: String) -> Result<Extracted, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let name = safe_file_name(&file);
    let path = base.join(&name);
    if !path.is_file() {
        return Err("file not found".into());
    }
    let ext = ext_of(&name);
    let (kind, raw) = match ext.as_str() {
        "pdf" => ("pdf", pdf_text(&path)?),
        "docx" => ("docx", docx_text(&path)?),
        "html" | "htm" => ("html", strip_tags(&read_utf8(&path)?)),
        "csv" => ("csv", read_utf8(&path)?),
        "json" => ("json", read_utf8(&path)?),
        "rtf" => ("rtf", strip_rtf(&read_utf8(&path)?)),
        _ => ("text", read_utf8(&path)?),
    };
    let text = normalize_ws(&raw);
    let truncated = text.chars().count() > MAX_CHARS;
    let text: String = text.chars().take(MAX_CHARS).collect();
    Ok(Extracted {
        file: name,
        kind: kind.into(),
        chars: text.chars().count(),
        truncated,
        text,
    })
}

fn read_utf8(p: &Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn pdf_text(p: &Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let t = pdf_extract::extract_text_from_mem(&bytes).map_err(|e| format!("pdf: {e}"))?;
    if t.trim().is_empty() {
        return Err("pdf has no extractable text (scanned image?)".into());
    }
    Ok(t)
}

fn docx_text(p: &Path) -> Result<String, String> {
    let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("docx: {e}"))?;
    let mut xml = String::new();
    {
        let mut doc = z.by_name("word/document.xml").map_err(|_| "docx: no document.xml".to_string())?;
        std::io::Read::read_to_string(&mut doc, &mut xml).map_err(|e| e.to_string())?;
    }
    // paragraphs and tabs become line breaks / spaces, then tags go
    let xml = xml
        .replace("</w:p>", "\n")
        .replace("<w:tab/>", " ")
        .replace("<w:br/>", "\n");
    Ok(strip_tags(&xml))
}

/// Remove markup, decode the common entities.
pub fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    let mut in_script = false;
    let lower = s.to_lowercase();
    let bytes: Vec<char> = s.chars().collect();
    let lchars: Vec<char> = lower.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if !in_tag && c == '<' {
            // skip <script>/<style> bodies
            let rest: String = lchars[i..std::cmp::min(i + 8, lchars.len())].iter().collect();
            if rest.starts_with("<script") || rest.starts_with("<style") {
                in_script = true;
            }
            if in_script && (rest.starts_with("</script") || rest.starts_with("</style")) {
                in_script = false;
            }
            in_tag = true;
            // block-level tags become line breaks
            let tag: String = lchars[i..std::cmp::min(i + 4, lchars.len())].iter().collect();
            if tag.starts_with("<p") || tag.starts_with("<br") || tag.starts_with("<li") || tag.starts_with("<h") || tag.starts_with("<tr") || tag.starts_with("<div") {
                out.push('\n');
            }
            i += 1;
            continue;
        }
        if in_tag {
            if c == '>' {
                in_tag = false;
            }
            i += 1;
            continue;
        }
        if !in_script {
            out.push(c);
        }
        i += 1;
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn strip_rtf(s: &str) -> String {
    // crude: drop control words and groups; good enough for pasted text
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut word = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphanumeric() || n == '-' {
                        word.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if word.starts_with("par") || word == "line" {
                    out.push('\n');
                }
                if chars.peek() == Some(&' ') {
                    chars.next();
                }
            }
            '{' | '}' => {}
            _ => out.push(c),
        }
    }
    out
}

fn normalize_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        let l = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() {
            blank += 1;
            if blank <= 1 {
                out.push('\n');
            }
            continue;
        }
        blank = 0;
        out.push_str(&l);
        out.push('\n');
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_becomes_text() {
        let t = strip_tags("<html><head><style>p{}</style></head><body><h1>Role</h1><p>Design &amp; build.</p><script>x()</script></body></html>");
        assert!(t.contains("Role"));
        assert!(t.contains("Design & build."));
        assert!(!t.contains("x()"));
        assert!(!t.contains("p{}"));
    }

    #[test]
    fn whitespace_is_normalized() {
        assert_eq!(normalize_ws("a   b\n\n\n\nc  "), "a b\n\nc");
    }

    #[test]
    fn names_are_sanitized() {
        assert_eq!(safe_file_name("/tmp/x/Job Desc (final).pdf"), "Job Desc (final).pdf");
        assert_eq!(safe_file_name("../../evil.pdf"), "evil.pdf");
    }
}

#[cfg(test)]
mod live_probe {
    /// ROBERT_PDF=/path/to/file.pdf cargo test pdf_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn pdf_probe() {
        let p = std::env::var("ROBERT_PDF").expect("ROBERT_PDF");
        let t = super::pdf_text(std::path::Path::new(&p)).expect("extract");
        let t = super::normalize_ws(&t);
        println!("{} chars\n{}", t.chars().count(), t.chars().take(600).collect::<String>());
        assert!(t.len() > 100);
    }
}
