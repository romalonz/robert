// Research: keyless web-search fallback the active brain synthesizes into a
// speakable line. The first proto-tool in Robert's tool registry. Moved
// verbatim out of the former robert.rs.

/// Keyless research fallback: DuckDuckGo's HTML results (no API key), top
/// snippets returned as plain text for the active brain to synthesize into a
/// speakable line. Lower quality than Exa, but free and always available.
#[tauri::command]
pub async fn robert_research_free(query: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query.as_str())])
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("web search failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("web search HTTP {}", res.status()));
    }
    let html = res.text().await.map_err(|e| e.to_string())?;

    // Pull result titles + snippets out of the HTML (no DOM dependency).
    fn strip_tags(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut in_tag = false;
        for c in s.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(c),
                _ => {}
            }
        }
        out.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&#x27;", "'")
            .replace("&quot;", "\"")
            .replace("&nbsp;", " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn extract<'a>(html: &'a str, marker: &str) -> Vec<String> {
        let mut items = Vec::new();
        for chunk in html.split(marker).skip(1) {
            // the element's inner HTML ends at the closing anchor/snippet tag
            let end = chunk.find("</a>").unwrap_or_else(|| chunk.len().min(400));
            let inner = &chunk[..end];
            // skip past the tag's remaining attributes to its content
            if let Some(gt) = inner.find('>') {
                let text = strip_tags(&inner[gt + 1..]);
                if !text.is_empty() {
                    items.push(text);
                }
            }
            if items.len() >= 5 {
                break;
            }
        }
        items
    }
    let titles = extract(&html, "class=\"result__a\"");
    let snippets = extract(&html, "class=\"result__snippet\"");
    if !titles.is_empty() || !snippets.is_empty() {
        let mut out = String::new();
        for i in 0..titles.len().max(snippets.len()).min(5) {
            if let Some(t) = titles.get(i) {
                out.push_str(&format!("- {}", t));
            }
            if let Some(s) = snippets.get(i) {
                out.push_str(&format!(": {}", s));
            }
            out.push('\n');
        }
        return Ok(out.trim().to_string());
    }

    // Layer 2: the HTML endpoint sometimes serves a challenge page under
    // rate pressure — fall back to DDG's Instant Answer JSON API (separate
    // service, keyless, never challenges; sparser but often enough).
    let res = client
        .get("https://api.duckduckgo.com/")
        .query(&[("q", query.as_str()), ("format", "json"), ("no_html", "1")])
        .send()
        .await
        .map_err(|e| format!("web search failed: {}", e))?;
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    if let Some(a) = v.get("AbstractText").and_then(|x| x.as_str()) {
        if !a.is_empty() {
            out.push_str(&format!("- {}\n", a));
        }
    }
    if let Some(a) = v.get("Answer").and_then(|x| x.as_str()) {
        if !a.is_empty() {
            out.push_str(&format!("- {}\n", a));
        }
    }
    if let Some(topics) = v.get("RelatedTopics").and_then(|x| x.as_array()) {
        for t in topics.iter().take(4) {
            if let Some(txt) = t.get("Text").and_then(|x| x.as_str()) {
                if !txt.is_empty() {
                    out.push_str(&format!("- {}\n", txt));
                }
            }
        }
    }
    if out.trim().is_empty() {
        return Err("web search returned no readable results".into());
    }
    Ok(out.trim().to_string())
}
