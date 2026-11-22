use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct HandleCandidate {
    pub handle: String,
    pub pattern: &'static str,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct EmailCandidate {
    pub email: String,
    pub pattern: &'static str,
    pub confidence: f32,
}

fn clean_token(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// Generate ranked handle candidates directly from a person's full name (and optional explicit handle).
pub fn generate_handles(full_name: &str, explicit_handle: Option<&str>) -> Vec<HandleCandidate> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Some(h) = explicit_handle {
        let trimmed = h.trim().trim_start_matches('@').to_lowercase();
        if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
            out.push(HandleCandidate {
                handle: trimmed,
                pattern: "seed_handle",
                confidence: 0.92,
            });
        }
    }

    let parts: Vec<String> = full_name
        .split_whitespace()
        .map(clean_token)
        .filter(|s| !s.is_empty())
        .collect();

    if parts.is_empty() {
        return out;
    }

    let mut push = |handle: String, pattern: &'static str, confidence: f32| {
        if handle.len() >= 3 && seen.insert(handle.clone()) {
            out.push(HandleCandidate {
                handle,
                pattern,
                confidence,
            });
        }
    };

    if parts.len() == 1 {
        push(parts[0].clone(), "single_token", 0.55);
        return out;
    }

    let first = &parts[0];
    let last = &parts[parts.len() - 1];
    let f_init = first.chars().next().unwrap();
    let l_init = last.chars().next().unwrap();

    // High-signal executive & developer handle conventions (specific full-name handles first)
    push(format!("{}{}", first, last), "firstlast", 0.68);
    push(format!("{}.{}", first, last), "first.last", 0.64);
    push(format!("{}-{}", first, last), "first-last", 0.62);
    push(format!("{}_{}", first, last), "first_last", 0.60);
    push(format!("{}{}", f_init, last), "flast", 0.56);
    if last.len() >= 6 {
        push(last.clone(), "lastname", 0.54);
    }
    push(format!("{}{}", first, l_init), "firstl", 0.50);
    push(format!("{}{}", last, first), "lastfirst", 0.46);

    if parts.len() >= 3 {
        let mid = &parts[1];
        if let Some(m_init) = mid.chars().next() {
            push(format!("{}{}{}", first, m_init, last), "firstmlast", 0.54);
            push(format!("{}{}{}", f_init, m_init, last), "fmlast", 0.52);
        }
    }

    out
}

/// Derive a clean domain string from an explicit domain or organization name if applicable.
pub fn normalize_domain(domain: Option<&str>, org: Option<&str>) -> Option<String> {
    if let Some(d) = domain {
        let clean = d
            .trim()
            .to_lowercase()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.")
            .split('/')
            .next()
            .unwrap_or("")
            .to_string();
        if clean.contains('.') && clean.len() >= 4 {
            return Some(clean);
        }
    }
    if let Some(o) = org {
        let trimmed = o.trim().to_lowercase();
        if trimmed.contains('.') && !trimmed.contains(' ') {
            return Some(trimmed);
        }
    }
    None
}

/// Generate domain-scoped corporate email candidates when a target domain is known.
pub fn generate_corporate_emails(
    full_name: &str,
    domain: &str,
    explicit_email: Option<&str>,
) -> Vec<EmailCandidate> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Some(e) = explicit_email {
        let clean = e.trim().to_lowercase();
        if clean.contains('@') && seen.insert(clean.clone()) {
            out.push(EmailCandidate {
                email: clean,
                pattern: "seed_email",
                confidence: 0.95,
            });
        }
    }

    let dom = domain.trim().to_lowercase();
    if !dom.contains('.') {
        return out;
    }

    let parts: Vec<String> = full_name
        .split_whitespace()
        .map(clean_token)
        .filter(|s| !s.is_empty())
        .collect();

    if parts.len() < 2 {
        return out;
    }

    let first = &parts[0];
    let last = &parts[parts.len() - 1];
    let f_init = first.chars().next().unwrap();

    let candidates = [
        (format!("{}.{}@{}", first, last, dom), "first.last", 0.62),
        (format!("{}{}@{}", f_init, last, dom), "flast", 0.58),
        (format!("{}@{}", first, dom), "first", 0.52),
        (format!("{}{}@{}", first, last, dom), "firstlast", 0.50),
        (format!("{}_{}@{}", first, last, dom), "first_last", 0.45),
    ];

    for (email, pattern, confidence) in candidates {
        if seen.insert(email.clone()) {
            out.push(EmailCandidate {
                email,
                pattern,
                confidence,
            });
        }
    }

    out
}
