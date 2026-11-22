use crate::models::{CaseSnapshot, Finding, GraphNode};
use regex::Regex;

/// Generate a self-contained, editorial executive intelligence dossier in HTML.
/// When `redact == true`, all sensitive fields, emails, phone numbers, and excerpts are cleanly masked.
pub fn render_dossier_html(snapshot: &CaseSnapshot, redact: bool) -> String {
    let email_re =
        Regex::new(r"(?i)\b([A-Za-z0-9._%+\-]{1,64})@([A-Za-z0-9.\-]+\.[A-Za-z]{2,12})\b").unwrap();
    let phone_re = Regex::new(r"\+?\d[\d\s\-().]{7,}\d").unwrap();

    let mask_text = |text: &str, sensitive: &[String]| -> String {
        if !redact {
            return html_escape(text);
        }
        let mut s = text.to_string();
        for sf in sensitive {
            let trimmed = sf.trim();
            if trimmed.len() >= 4 {
                s = s.replace(trimmed, &redact_token(trimmed));
            }
        }
        s = email_re
            .replace_all(&s, |caps: &regex::Captures| {
                let user = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let dom = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let prefix: String = user.chars().take(2).collect();
                format!("{}•••@{}", prefix, dom)
            })
            .to_string();
        s = phone_re.replace_all(&s, "[REDACTED PHONE]").to_string();
        html_escape(&s)
    };

    let target_name = html_escape(&snapshot.input.full_name);
    let org_line = snapshot
        .input
        .org
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(html_escape)
        .unwrap_or_else(|| "Unspecified".to_string());

    let mode_label = if snapshot.input.passive_only {
        "Passive Only"
    } else {
        "Active-Adjacent Enabled"
    };
    let redact_badge = if redact {
        "REDACTED BRIEF"
    } else {
        "UNREDACTED — AUTHORIZED EYES ONLY"
    };

    let active_nodes: Vec<&GraphNode> = snapshot
        .nodes
        .iter()
        .filter(|n| n.status != "dismissed")
        .collect();

    let mut anchors_html = String::new();
    for node in active_nodes
        .iter()
        .filter(|n| n.layer == "anchor" || n.status == "confirmed")
        .take(25)
    {
        let label = if redact && matches!(node.kind.as_str(), "email" | "phone" | "pgp_key") {
            html_escape(&redact_token(&node.label))
        } else {
            mask_text(&node.label, &[])
        };
        let sub = node
            .sublabel
            .as_deref()
            .map(|s| mask_text(s, &[]))
            .unwrap_or_default();
        anchors_html.push_str(&format!(
            "<tr><td><code>{}</code></td><td><strong>{}</strong><div class=\"sub\">{}</div></td><td>{}</td><td>{:.0}%</td><td>{}</td></tr>\n",
            html_escape(&node.kind),
            label,
            sub,
            html_escape(&node.status),
            node.confidence * 100.0,
            html_escape(&node.sources.join(", "))
        ));
    }

    let mut findings_html = String::new();
    for f in &snapshot.findings {
        findings_html.push_str(&render_finding_row(f, &mask_text));
    }

    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TAUF Intelligence Brief — {target_name}</title>
<style>
  :root {{
    --bg: #0f1115;
    --surface: #151820;
    --border: #262b36;
    --text: #e6e2da;
    --muted: #8f96a3;
    --accent: #d97706;
    --danger: #dc4c4c;
    --ok: #5ea898;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    padding: 40px 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    line-height: 1.55;
  }}
  .wrap {{ max-width: 960px; margin: 0 auto; }}
  header {{
    border-bottom: 1px solid var(--border);
    padding-bottom: 20px;
    margin-bottom: 28px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 16px;
  }}
  .kicker {{ font-size: 12px; color: var(--muted); letter-spacing: 0.06em; }}
  h1 {{ margin: 6px 0 4px; font-size: 28px; font-weight: 600; }}
  .badge {{
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--accent);
    background: rgba(217, 119, 6, 0.08);
  }}
  .kpis {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 28px;
  }}
  .kpi {{
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 14px 16px;
    border-radius: 6px;
  }}
  .kpi .num {{ font-size: 24px; font-weight: 600; }}
  .kpi .lbl {{ font-size: 12px; color: var(--muted); }}
  h2 {{
    font-size: 15px;
    font-weight: 600;
    margin: 28px 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  th, td {{ text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }}
  th {{ color: var(--muted); font-weight: 500; font-size: 12px; }}
  code {{ font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--ok); }}
  .sub {{ font-size: 12px; color: var(--muted); margin-top: 2px; }}
  .finding {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 10px;
  }}
  .finding-head {{ display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }}
  .finding-title {{ font-weight: 600; font-size: 14px; }}
  .sev {{ font-size: 11px; padding: 2px 7px; border-radius: 3px; border: 1px solid var(--border); }}
  .sev-critical, .sev-high {{ color: var(--danger); border-color: rgba(220,76,76,0.4); }}
  .sev-medium {{ color: var(--accent); border-color: rgba(217,119,6,0.4); }}
  .sev-low, .sev-info {{ color: var(--ok); border-color: rgba(94,168,152,0.4); }}
  .trail {{ font-size: 12px; color: var(--muted); margin-top: 8px; font-family: ui-monospace, Consolas, monospace; }}
  footer {{ margin-top: 36px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }}
  @media print {{
    body {{ background: #ffffff; color: #111111; padding: 12px; }}
    .kpi, .finding {{ background: #fafafa; border-color: #dddddd; }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <div class="kicker">TAUF Sovereign OSINT Dossier · Case {case_id}</div>
      <h1>{target_name}</h1>
      <div class="sub">Organization: {org_line} · Mode: {mode_label} · Generated: {created_at}</div>
    </div>
    <div class="badge">{redact_badge}</div>
  </header>

  <section class="kpis">
    <div class="kpi"><div class="num">{total_nodes}</div><div class="lbl">Identity Nodes</div></div>
    <div class="kpi"><div class="num">{confirmed_anchors}</div><div class="lbl">Confirmed Anchors</div></div>
    <div class="kpi"><div class="num">{verified_findings}</div><div class="lbl">Verified Findings</div></div>
    <div class="kpi"><div class="num">{exposure_hits}</div><div class="lbl">Dark Web &amp; Corpus Hits</div></div>
  </section>

  <h2>Identity Anchors</h2>
  <table>
    <thead>
      <tr><th>Kind</th><th>Entity</th><th>Status</th><th>Confidence</th><th>Sources</th></tr>
    </thead>
    <tbody>
      {anchors_html}
    </tbody>
  </table>

  <h2>Consensus Findings ({finding_count})</h2>
  {findings_html}

  <footer>
    Generated locally by TAUF (100% sovereign direct-from-laptop execution; zero external OSINT APIs).
  </footer>
</div>
</body>
</html>
"#,
        target_name = target_name,
        case_id = html_escape(&snapshot.case_id),
        org_line = org_line,
        mode_label = mode_label,
        created_at = html_escape(&snapshot.created_at),
        redact_badge = redact_badge,
        total_nodes = snapshot.stats.total_nodes,
        confirmed_anchors = snapshot.stats.confirmed_anchors,
        verified_findings = snapshot.stats.verified_findings,
        exposure_hits = snapshot.stats.darkweb_hits + snapshot.stats.breach_hits,
        anchors_html = if anchors_html.is_empty() {
            "<tr><td colspan=\"5\" class=\"sub\">No anchors recorded yet.</td></tr>".to_string()
        } else {
            anchors_html
        },
        finding_count = snapshot.findings.len(),
        findings_html = if findings_html.is_empty() {
            "<p class=\"sub\">No findings recorded.</p>".to_string()
        } else {
            findings_html
        },
    )
}

fn render_finding_row<F>(f: &Finding, mask_text: &F) -> String
where
    F: Fn(&str, &[String]) -> String,
{
    let title = mask_text(&f.title, &f.sensitive_fields);
    let summary = mask_text(&f.summary, &f.sensitive_fields);
    let trail: Vec<String> = f
        .pivot_trail
        .iter()
        .map(|step| mask_text(step, &f.sensitive_fields))
        .collect();
    let sev_class = format!("sev-{}", html_escape(&f.severity));

    format!(
        r#"<div class="finding">
  <div class="finding-head">
    <div class="finding-title">{title}</div>
    <span class="sev {sev_class}">{sev} · {consensus} source(s) · {conf:.0}%</span>
  </div>
  <div class="sub">{summary}</div>
  <div class="trail">{trail}</div>
</div>
"#,
        title = title,
        sev_class = sev_class,
        sev = html_escape(&f.severity),
        consensus = f.consensus_count,
        conf = f.confidence * 100.0,
        summary = summary,
        trail = trail.join(" → "),
    )
}

fn redact_token(val: &str) -> String {
    if let Some((user, dom)) = val.split_once('@') {
        let prefix: String = user.chars().take(2).collect();
        return format!("{}•••@{}", prefix, dom);
    }
    let chars: Vec<char> = val.chars().collect();
    if chars.len() <= 4 {
        "••••".to_string()
    } else {
        let head: String = chars[..2].iter().collect();
        let tail: String = chars[chars.len() - 2..].iter().collect();
        format!("{}••••{}", head, tail)
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
