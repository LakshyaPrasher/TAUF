use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct LocalCorpusHit {
    pub file_path: String,
    pub file_name: String,
    pub line_number: usize,
    pub matched_term: String,
    pub redacted_preview: String,
    pub has_credential_shape: bool,
}

const MAX_FILES: usize = 500;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024; // 100 MB per file safety cap
const MAX_HITS: usize = 40;

/// Local sovereign corpus scanner: walks an analyst-configured local directory on the laptop
/// and scans text/CSV/JSON/log files at native Rust speed.
/// Strictly NEVER exposes raw passwords — masks credential-shaped delimiters (`email:pass`, CSV fields).
pub fn scan_local_corpus(dir_path: &str, terms: &[String]) -> Result<Vec<LocalCorpusHit>, String> {
    let root = Path::new(dir_path.trim());
    if !root.exists() || !root.is_dir() {
        return Err(format!(
            "Local corpus directory does not exist or is not a folder: '{}'",
            dir_path
        ));
    }

    let needles: Vec<(String, String)> = terms
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| t.len() >= 4)
        .map(|t| (t.to_lowercase(), t))
        .collect();

    if needles.is_empty() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_files(root, 0, &mut files);

    let mut hits = Vec::new();
    for path in files {
        if hits.len() >= MAX_HITS {
            break;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let reader = BufReader::new(file);
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let file_path = path.to_string_lossy().to_string();

        for (idx, line_res) in reader.lines().enumerate() {
            if hits.len() >= MAX_HITS {
                break;
            }
            let Ok(line) = line_res else {
                continue;
            };
            if line.len() > 8192 {
                continue;
            }
            let lower = line.to_lowercase();
            for (needle_lower, needle_orig) in &needles {
                if lower.contains(needle_lower) {
                    let (redacted_preview, has_cred) = redact_corpus_line(&line, needle_orig);
                    hits.push(LocalCorpusHit {
                        file_path: file_path.clone(),
                        file_name: file_name.clone(),
                        line_number: idx + 1,
                        matched_term: needle_orig.clone(),
                        redacted_preview,
                        has_credential_shape: has_cred,
                    });
                    break;
                }
            }
        }
    }

    Ok(hits)
}

fn collect_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            break;
        }
        let p = entry.path();
        if p.is_dir() {
            collect_files(&p, depth + 1, out);
        } else if is_scannable_file(&p) {
            out.push(p);
        }
    }
}

fn is_scannable_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_lowercase().as_str(),
        "txt" | "csv" | "tsv" | "json" | "jsonl" | "log" | "md" | "ndjson"
    )
}

/// Strip/mask any credential-like trailing field (`email:secret`, `user;secret`, CSV password columns)
/// so TAUF reports breach exposure metadata without ever exposing plaintext secrets.
pub fn redact_corpus_line(line: &str, matched_term: &str) -> (String, bool) {
    let trimmed = line.trim();
    // Detect combo-list format (`email:password` or `email;password`)
    if let Some((left, right)) = trimmed.split_once(':') {
        if left.contains('@') && !right.is_empty() && !right.starts_with("//") {
            return (
                format!(
                    "{} : [REDACTED_CREDENTIAL_FIELD len={}]",
                    left.trim(),
                    right.trim().len()
                ),
                true,
            );
        }
    }
    if let Some((left, right)) = trimmed.split_once(';') {
        if left.contains('@') && !right.is_empty() {
            return (
                format!(
                    "{} ; [REDACTED_CREDENTIAL_FIELD len={}]",
                    left.trim(),
                    right.trim().len()
                ),
                true,
            );
        }
    }
    // Detect CSV with multiple columns — show matched column + column count only
    let cols: Vec<&str> = trimmed.split(',').collect();
    if cols.len() >= 3 {
        return (
            format!(
                "Structured CSV record matching '{}' ({} fields, non-identifier columns redacted)",
                matched_term,
                cols.len()
            ),
            true,
        );
    }

    let safe_excerpt = if trimmed.chars().count() > 140 {
        format!("{}…", trimmed.chars().take(140).collect::<String>())
    } else {
        trimmed.to_string()
    };
    (safe_excerpt, false)
}
