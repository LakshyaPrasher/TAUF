#!/usr/bin/env python3
"""
TAUF Local Sovereign Open-Source Sidecar Bridge V5 (Python 3.12+)
-----------------------------------------------------------------------
Strictly ZERO external OSINT SaaS APIs (paid or free) and ZERO API keys.
Auto-detects and invokes the 7 wired open-source tools inside `sidecar/.venv`,
streaming normalized JSONL events back over stdout in parallel.

Verified V5 Tor/Proxy Behavior:
- `holehe` & `ignorant`: run directly in-process via Trio + httpx (`socksio`) with
  `proxy="socks5://..."` and strict `trio.move_on_after()` cap (zero hangs, zero lost hits).
- `maigret`: runs multi-handle parallel checks with clean env + `--proxy socks5h://...`
  + `--no-autoupdate`, emitting canonical `platform`/`handle` metadata.
- `sherlock`: runs multi-handle parallel checks with `--local --proxy socks5h://...`
  on curated high-signal sites (no Linktree/WordPress soft-404 noise, no clearnet data.json fetch).
- `socid-extractor`: runs in-process via `requests` + `socks5h://` and emits
  `entity_kind: "enrichment"` to merge structured attributes onto existing nodes.
- `onionsearch`: quotes multi-word full-name queries, patches live v3 `.onion` engines,
  and emits normalized `engine`/`matched_term` metadata over Tor.
- `h8mail`: strictly offline `-lb <local_corpus_dir> --skip-defaults` with version check
  disabled (zero network calls) and `email` metadata for graph branching.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urlparse

ACTIVE_ADJACENT_TOOLS = {"holehe", "ignorant"}
_EMIT_LOCK = threading.Lock()
_TERMINAL_TOOL_STATES = {"done", "skipped", "error"}
_TERMINAL_EMITTED: set[str] = set()

# Prepend sidecar/.venv/Scripts (or bin) to PATH and site-packages to sys.path/PYTHONPATH
# so installed venv tools are always discoverable & importable even when an OS policy
# requires running under a system Python interpreter instead of .venv/Scripts/python.exe.
_SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
for _vbin in (
    os.path.join(_SIDECAR_DIR, ".venv", "Scripts"),
    os.path.join(_SIDECAR_DIR, ".venv", "bin"),
):
    if os.path.isdir(_vbin) and _vbin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _vbin + os.pathsep + os.environ.get("PATH", "")

_VENV_SITE_DIRS: list[str] = []
_win_sp = os.path.join(_SIDECAR_DIR, ".venv", "Lib", "site-packages")
if os.path.isdir(_win_sp):
    _VENV_SITE_DIRS.append(_win_sp)
_unix_lib = os.path.join(_SIDECAR_DIR, ".venv", "lib")
if os.path.isdir(_unix_lib):
    try:
        for _entry in os.listdir(_unix_lib):
            _sp = os.path.join(_unix_lib, _entry, "site-packages")
            if _entry.startswith("python") and os.path.isdir(_sp):
                _VENV_SITE_DIRS.append(_sp)
    except Exception:
        pass
for _sp in reversed(_VENV_SITE_DIRS):
    if _sp not in sys.path:
        sys.path.insert(0, _sp)
if _VENV_SITE_DIRS:
    _existing_pp = os.environ.get("PYTHONPATH", "")
    _missing_pp = [p for p in _VENV_SITE_DIRS if p not in _existing_pp.split(os.pathsep)]
    if _missing_pp:
        os.environ["PYTHONPATH"] = os.pathsep.join(_missing_pp + ([_existing_pp] if _existing_pp else []))

# High-signal curated site list for fast, reliable Sherlock execution over Tor
# (Linktree, WordPress, TryHackMe, and Bandcamp excluded due to soft-404 / SPA false positives)
SHERLOCK_HIGH_SIGNAL_SITES = [
    "GitHub", "GitLab", "Reddit", "HackerNews", "Keybase", "Medium",
    "DEV Community", "PyPI", "npm", "Docker Hub", "Kaggle", "CodePen",
    "Behance", "Dribbble", "Vimeo", "SoundCloud", "Telegram",
    "About.me", "Patreon", "Goodreads", "Letterboxd", "Flickr", "Steam Community (User)",
    "Twitch", "Bitbucket", "ProductHunt", "SpeakerDeck",
    "HackerOne", "Pastebin", "Pinterest", "Mastodon.social",
    "Mixcloud", "Unsplash", "Imgur", "Disqus", "Gravatar",
    "Freelancer", "Codecademy", "LeetCode", "Codewars", "Replit.com",
    "Launchpad", "SourceForge", "Blogger",
]

BLOCKED_SPA_HOSTS = (
    "crates.io",
    "substack.com",
    "bsky.app",
    "archive.org",
    "500px.com",
    "slideshare.net",
    "thingiverse.com",
    "wordpress.com",
    "linktr.ee",
    "tryhackme.com",
    "bandcamp.com",
    "osintsearch.org",
)


_FEED_OR_ASSET_URL_RE = re.compile(r"\.(atom|rss|xml|json)(?:$|[?#])", re.I)


def is_feed_or_asset_url(url: str) -> bool:
    return bool(_FEED_OR_ASSET_URL_RE.search(url.strip()))


def is_blocked_spa_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    return any(host == dom or host.endswith("." + dom) for dom in BLOCKED_SPA_HOSTS)


LIVE_AHMIA_V3 = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion"
LIVE_ONIONLAND_V3 = "http://3bbad7fauom4d6sgppalyqddsqbf5u5p56b5k5uk2zxsy3d6ey2jobad.onion"

TOOL_CATALOG = [
    {
        "name": "maigret",
        "cli": ["maigret"],
        "module": "maigret",
        "category": "account",
        "mode": "passive",
        "install_hint": "pip install maigret",
    },
    {
        "name": "sherlock",
        "cli": ["sherlock"],
        "module": "sherlock_project",
        "category": "account",
        "mode": "passive",
        "install_hint": "pip install sherlock-project",
    },
    {
        "name": "socid-extractor",
        "cli": ["socid-extractor"],
        "module": "socid_extractor",
        "category": "anchor",
        "mode": "passive",
        "install_hint": "pip install socid-extractor",
    },
    {
        "name": "holehe",
        "cli": ["holehe"],
        "module": "holehe",
        "category": "service",
        "mode": "active_adjacent",
        "install_hint": "pip install holehe socksio",
    },
    {
        "name": "ignorant",
        "cli": ["ignorant"],
        "module": "ignorant",
        "category": "service",
        "mode": "active_adjacent",
        "install_hint": "pip install ignorant socksio",
    },
    {
        "name": "h8mail",
        "cli": ["h8mail"],
        "module": "h8mail",
        "category": "breach",
        "mode": "passive",
        "install_hint": "pip install h8mail (local-corpus mode only)",
    },
    {
        "name": "onionsearch",
        "cli": ["onionsearch"],
        "module": "onionsearch",
        "category": "darkweb",
        "mode": "passive",
        "install_hint": "pip install onionsearch",
    },
]


def emit(event: dict[str, Any]) -> None:
    with _EMIT_LOCK:
        if (
            event.get("kind") == "tool_status"
            and event.get("tool")
            and event.get("state") in _TERMINAL_TOOL_STATES
        ):
            _TERMINAL_EMITTED.add(str(event["tool"]))
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def ensure_socks5h(raw: str | None) -> str | None:
    if not raw or not raw.strip():
        return None
    s = raw.strip()
    if s.startswith("socks5h://"):
        return s
    if s.startswith("socks5://"):
        return "socks5h://" + s[len("socks5://") :]
    return s


def to_httpx_socks5(raw: str | None) -> str | None:
    """Keep `socks5h://` so the SOCKS proxy resolves DNS remotely (no local DNS leak)."""
    if not raw or not raw.strip():
        return None
    s = raw.strip()
    if s.startswith("socks5h://"):
        return s
    if s.startswith("socks5://"):
        return "socks5h://" + s[len("socks5://") :]
    return s


def is_importable(spec: dict[str, Any]) -> bool:
    mod = spec.get("module")
    if not mod or "-" in mod:
        return False
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def is_tool_installed(spec: dict[str, Any]) -> bool:
    if is_importable(spec):
        return True
    for binary in spec["cli"]:
        if shutil.which(binary):
            return True
    return False


def probe_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": spec["name"],
            "installed": is_tool_installed(spec),
            # Honest sub-signal: a PATH shim can exist while the module is not
            # importable in the running interpreter (venv/App-Control mismatch).
            "importable": is_importable(spec),
            "category": spec["category"],
            "mode": spec["mode"],
            "install_hint": spec["install_hint"],
        }
        for spec in TOOL_CATALOG
    ]


def build_clean_env(proxy_url: str | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    for k in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        env.pop(k, None)
    if proxy_url:
        env["ALL_PROXY"] = proxy_url
        env["HTTP_PROXY"] = proxy_url
        env["HTTPS_PROXY"] = proxy_url
    return env


def strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def name_parts(full_name: str) -> list[str]:
    return [w for w in re.sub(r"[^a-z0-9\s]", " ", full_name.lower()).split() if len(w) >= 2]


def fullname_matches(candidate: str, target_full_name: str) -> bool:
    low = candidate.lower()
    parts = name_parts(target_full_name)
    if not parts:
        return True
    if len(parts) == 1:
        return parts[0] in low
    return parts[0] in low and parts[-1] in low


def parse_phone_cc_number(phone: str) -> tuple[str, str] | None:
    cleaned = re.sub(r"[^\d+]", "", phone.strip())
    if not cleaned:
        return None
    if cleaned.startswith("+"):
        digits = cleaned[1:]
        if len(digits) >= 10:
            if digits.startswith("1") and len(digits) == 11:
                return "1", digits[1:]
            if len(digits) >= 11:
                return digits[:2], digits[2:]
            return "1", digits
    parts = phone.lstrip("+").split()
    if len(parts) >= 2:
        cc = re.sub(r"\D", "", parts[0])
        num = re.sub(r"\D", "", "".join(parts[1:]))
        if cc and len(num) >= 6:
            return cc, num
    return None


def stream_python_code(
    code: str, env: dict[str, str], timeout: int = 38
) -> tuple[int, list[str]]:
    """Run Python code in an isolated temp directory and collect lines even if timeout cap is reached."""
    lines: list[str] = []
    tmp_cwd = tempfile.mkdtemp(prefix="tauf_sc_")
    try:
        kwargs: dict[str, Any] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "env": env,
            "cwd": tmp_cwd,
        }
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        proc = subprocess.Popen([sys.executable, "-u", "-c", code], **kwargs)
    except Exception as exc:
        shutil.rmtree(tmp_cwd, ignore_errors=True)
        return 1, [str(exc)]

    def _reader() -> None:
        if not proc.stdout:
            return
        for ln in proc.stdout:
            lines.append(ln.rstrip("\r\n"))

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if proc.poll() is None:
        try:
            proc.kill()
        except Exception:
            pass
        t.join(timeout=2)
    rc = proc.returncode if proc.returncode is not None else 124
    shutil.rmtree(tmp_cwd, ignore_errors=True)
    return rc, lines


def run_holehe_direct(
    email: str,
    active_proxy: str | None,
    depth_level: int = 2,
    timeout_ms: int | None = None,
) -> list[dict[str, Any]]:
    """Run Holehe modules directly via Trio + httpx (socksio) with CapacityLimiter(18) so Tor circuits aren't choked."""
    httpx_proxy = to_httpx_socks5(active_proxy)
    if timeout_ms:
        subproc_timeout = max(6, int(timeout_ms) // 1000)
        # Leave headroom inside the outer subprocess cap for trio shutdown.
        trio_timeout = max(5, subproc_timeout - 4)
    else:
        trio_timeout = {2: 30, 3: 38, 4: 44}.get(depth_level, 30)
        subproc_timeout = trio_timeout + 8
    code = f"""
import json, trio, httpx
from holehe.core import import_submodules, get_functions, launch_module

async def _go():
    modules = import_submodules("holehe.modules")
    funcs = get_functions(modules)
    out = []
    limiter = trio.CapacityLimiter(18)
    client_kwargs = {{"timeout": httpx.Timeout(8.0, connect=6.5)}}
    if {json.dumps(httpx_proxy)}:
        client_kwargs["proxy"] = {json.dumps(httpx_proxy)}

    async def _run_mod(fn, client):
        async with limiter:
            await launch_module(fn, {json.dumps(email)}, client, out)

    async with httpx.AsyncClient(**client_kwargs) as client:
        with trio.move_on_after({trio_timeout}):
            async with trio.open_nursery() as nursery:
                for fn in funcs:
                    nursery.start_soon(_run_mod, fn, client)
    hits = [r for r in out if isinstance(r, dict) and r.get("exists") is True]
    print("HOLEHE_JSON:" + json.dumps({{"checked": len(out), "hits": hits}}, ensure_ascii=False))

trio.run(_go)
"""
    rc, lines = stream_python_code(code, build_clean_env(None), timeout=subproc_timeout)
    for ln in reversed(lines):
        if ln.startswith("HOLEHE_JSON:"):
            try:
                return json.loads(ln[len("HOLEHE_JSON:") :]).get("hits", [])
            except Exception:
                pass
    return []


def run_ignorant_direct(cc: str, num: str, active_proxy: str | None) -> list[dict[str, Any]]:
    """Run Ignorant modules directly via Trio + httpx (socksio) with CapacityLimiter(12) and 24s cap."""
    httpx_proxy = to_httpx_socks5(active_proxy)
    code = f"""
import json, trio, httpx
from ignorant.core import import_submodules, get_functions, launch_module

async def _go():
    modules = import_submodules("ignorant.modules")
    funcs = get_functions(modules)
    out = []
    limiter = trio.CapacityLimiter(12)
    client_kwargs = {{"timeout": httpx.Timeout(8.0, connect=6.5)}}
    if {json.dumps(httpx_proxy)}:
        client_kwargs["proxy"] = {json.dumps(httpx_proxy)}

    async def _run_mod(fn, client):
        async with limiter:
            await launch_module(fn, {json.dumps(num)}, {json.dumps(cc)}, client, out)

    async with httpx.AsyncClient(**client_kwargs) as client:
        with trio.move_on_after(24):
            async with trio.open_nursery() as nursery:
                for fn in funcs:
                    nursery.start_soon(_run_mod, fn, client)
    hits = [r for r in out if isinstance(r, dict) and r.get("exists") is True]
    print("IGNORANT_JSON:" + json.dumps({{"checked": len(out), "hits": hits}}, ensure_ascii=False))

trio.run(_go)
"""
    rc, lines = stream_python_code(code, build_clean_env(None), timeout=30)
    for ln in reversed(lines):
        if ln.startswith("IGNORANT_JSON:"):
            try:
                return json.loads(ln[len("IGNORANT_JSON:") :]).get("hits", [])
            except Exception:
                pass
    return []


def parse_maigret_lines(lines: list[str]) -> list[dict[str, Any]]:
    """Parse Maigret stdout `[+] Site: https://...` blocks along with nested `├─key: value` attributes."""
    results: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in lines:
        line = strip_ansi(raw).strip()
        m = re.match(r"^\[\+\]\s+([^:\[\]]+?)(?:\s+\[[^\]]+\])?:\s+(https?://\S+)", line)
        if m:
            if current:
                results.append(current)
            current = {
                "site": m.group(1).strip(),
                "url": m.group(2).strip(),
                "attrs": {},
            }
            continue
        if current and (line.startswith("├─") or line.startswith("└─") or line.startswith("|-") or line.startswith("`-")):
            kv = line[2:].strip()
            if ":" in kv:
                k, v = kv.split(":", 1)
                current["attrs"][k.strip().lower()] = v.strip()
        elif not line and current:
            results.append(current)
            current = None
    if current:
        results.append(current)
    return results


def _str_list(value: Any) -> list[str]:
    """Accept a single string or a list of strings; never iterate a string char-by-char."""
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str) and v.strip()]
    return []


def run_sidecar(payload: dict[str, Any]) -> None:
    # SC-6: a malformed/non-object payload must not crash the bridge with a traceback.
    if not isinstance(payload, dict):
        emit(
            {
                "kind": "tool_status",
                "tool": "payload",
                "state": "error",
                "hits": 0,
                "detail": "payload must be a JSON object",
            }
        )
        return
    passive_only: bool = payload.get("passive_only") is True
    enable_tor: bool = payload.get("enable_tor") is True
    strict_anonymity: bool = payload.get("strict_anonymity") is True
    try:
        depth_level = max(1, min(4, int(payload.get("depth_level") or 2)))
    except (TypeError, ValueError):
        depth_level = 2
    full_name: str = str(payload.get("full_name") or "").strip()
    handles: list[str] = [
        h.strip().lstrip("@") for h in _str_list(payload.get("handles")) if h.strip()
    ]
    emails: list[str] = [
        e.strip().lower() for e in _str_list(payload.get("emails")) if "@" in e
    ]
    profile_urls: list[str] = [
        u.strip()
        for u in _str_list(payload.get("profile_urls"))
        if u.strip().startswith("http")
    ]
    phones: list[str] = [
        p.strip()
        for p in (_str_list(payload.get("phones")) or _str_list(payload.get("phone")))
        if p.strip()
    ]
    phone: str = phones[0] if phones else ""
    local_corpus_dir: str = str(payload.get("local_corpus_dir") or "").strip()
    tor_socks_url = ensure_socks5h(payload.get("tor_socks_url"))
    proxy_url = ensure_socks5h(payload.get("proxy_url"))
    active_proxy = tor_socks_url if (enable_tor or strict_anonymity) and tor_socks_url else proxy_url
    # SC-8: the Node side kills this process at `sidecar_budget_ms`; keep the
    # internal per-email budgets strictly inside that cap.
    try:
        sidecar_budget_ms = int(payload.get("sidecar_budget_ms") or 75_000)
    except (TypeError, ValueError):
        sidecar_budget_ms = 75_000

    unique_handles: list[str] = []
    seen_handles_low: set[str] = set()
    for h in handles:
        hl = h.lower()
        if hl and hl not in seen_handles_low:
            seen_handles_low.add(hl)
            unique_handles.append(h)

    primary_handle = unique_handles[0] if unique_handles else ""
    primary_email = emails[0] if emails else ""
    domains: list[str] = [
        d.strip().lower() for d in _str_list(payload.get("domains")) if "." in d.strip()
    ]
    primary_domain = domains[0] if domains else ""
    proxy_label = " via Tor" if active_proxy else ""

    # Depth 1 (Quick): skip heavy external sidecar crawlers so Quick mode completes in ~20s
    if depth_level == 1:
        for spec in TOOL_CATALOG:
            if is_tool_installed(spec):
                emit({"kind": "tool_status", "tool": spec["name"], "state": "skipped", "hits": 0, "detail": "Quick depth (L1)"})
            else:
                emit({"kind": "tool_status", "tool": spec["name"], "state": "skipped", "hits": 0, "detail": "not installed"})
        return

    maigret_top = {2: "25", 3: "60", 4: "100"}.get(depth_level, "25")
    maigret_timeout = {2: 45, 3: 68, 4: 90}.get(depth_level, 45)
    sherlock_count = {2: 26, 3: 38, 4: 50}.get(depth_level, 26)
    sherlock_timeout = {2: 38, 3: 58, 4: 80}.get(depth_level, 38)
    socid_limit = {2: 5, 3: 10, 4: 12}.get(depth_level, 5)
    holehe_email_limit = {2: 1, 3: 2, 4: 3}.get(depth_level, 1)
    handle_scan_limit = 3 if depth_level >= 4 else 2

    def _run_one(spec: dict[str, Any]) -> None:
        name = spec["name"]
        installed = is_tool_installed(spec)

        if name in ACTIVE_ADJACENT_TOOLS and passive_only:
            emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "Passive-only mode ON"})
            return

        if not installed:
            emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "not installed"})
            return

        # -----------------------------------------------------------------
        # 1. h8mail — STRICTLY OFFLINE LOCAL CORPUS MODE ONLY (Zero APIs)
        # -----------------------------------------------------------------
        if name == "h8mail":
            if not primary_email:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "needs email"})
                return
            abs_corpus_dir = os.path.abspath(local_corpus_dir) if local_corpus_dir else ""
            if not abs_corpus_dir or not os.path.isdir(abs_corpus_dir):
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "no corpus folder"})
                return
            corpus_files = [
                fn
                for fn in os.listdir(abs_corpus_dir)
                if fn.lower() != "readme.txt"
                and os.path.isfile(os.path.join(abs_corpus_dir, fn))
                and os.path.splitext(fn)[1].lower() in (".txt", ".csv", ".tsv", ".json", ".jsonl", ".log")
            ]
            if not corpus_files:
                emit({"kind": "tool_status", "tool": name, "state": "done", "hits": 0, "detail": "0 hits (corpus folder empty)"})
                return
            emit({"kind": "tool_status", "tool": name, "state": "running", "hits": 0, "detail": f"Offline corpus scan for {primary_email}"})
            argv = ["h8mail", "-t", primary_email, "-lb", abs_corpus_dir, "--skip-defaults"]
            code = (
                f"import sys; sys.argv = {json.dumps(argv)}; "
                "import h8mail.utils.run as hr; "
                "hr.check_latest_version = lambda *a, **kw: None; "
                "hr.check_scylla_online = lambda *a, **kw: False; "
                "from h8mail.__main__ import main; main()"
            )
            rc, lines = stream_python_code(code, build_clean_env(None), timeout=18)
            clean_lines = [strip_ansi(ln) for ln in lines]
            hits = sum(
                1
                for ln in clean_lines
                if primary_email in ln.lower()
                and ("local_breach" in ln.lower() or "breach:" in ln.lower() or "found" in ln.lower())
                and "targets found" not in ln.lower()
                and "0 targets" not in ln.lower()
            )
            if hits > 0:
                emit(
                    {
                        "kind": "finding",
                        "tool": name,
                        "entity_kind": "breach",
                        "label": f"h8mail Local Corpus ({primary_email})",
                        "category": "breach",
                        "confidence": 0.92,
                        "match_tier": "verified",
                        "match_reason": "Local breach corpus match (h8mail)",
                        "metadata": {
                            "email": primary_email,
                            "source": "h8mail_local_corpus",
                        },
                        "summary": f"h8mail offline local-corpus scan matched {primary_email} ({hits} record(s), credentials redacted).",
                    }
                )
            emit({"kind": "tool_status", "tool": name, "state": "done", "hits": hits, "detail": f"{hits} local corpus hit(s)"})
            return

        # Fail-closed anonymity guard for all network sidecar tools
        if strict_anonymity and not active_proxy:
            emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "Strict Anonymity (Tor offline)"})
            return

        # -----------------------------------------------------------------
        # 2. holehe — Direct in-process Trio + httpx (socksio) with CapacityLimiter(18)
        # -----------------------------------------------------------------
        if name == "holehe":
            if not emails:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "needs email"})
                return
            target_emails = emails[:holehe_email_limit]
            depth_email_cap = {2: 38_000, 3: 46_000, 4: 52_000}.get(depth_level, 38_000)
            per_email_ms = max(
                18_000,
                min(depth_email_cap, (sidecar_budget_ms - 5_000) // max(1, len(target_emails))),
            )
            emit({"kind": "tool_status", "tool": name, "state": "running", "hits": 0, "detail": f"Checking {len(target_emails)} email(s){proxy_label}"})
            seen_doms = set()
            emitted = 0
            for checked_idx, em in enumerate(target_emails, start=1):
                found_hits = run_holehe_direct(
                    em, active_proxy, depth_level=depth_level, timeout_ms=per_email_ms
                )
                for item in found_hits:
                    dom = str(item.get("domain") or item.get("name") or "").strip()
                    key = f"{dom}:{em}"
                    if not dom or key in seen_doms:
                        continue
                    seen_doms.add(key)
                    emitted += 1
                    extras = []
                    if item.get("emailrecovery"):
                        extras.append(f"recovery email hint: {item['emailrecovery']}")
                    if item.get("phoneNumber"):
                        extras.append(f"phone hint: {item['phoneNumber']}")
                    extra_txt = f" · {'; '.join(extras)}" if extras else ""
                    emit(
                        {
                            "kind": "finding",
                            "tool": name,
                            "entity_kind": "service",
                            "label": f"{dom}",
                            "category": "service",
                            "confidence": 0.88,
                            "match_tier": "verified",
                            "match_reason": f"Registered service for {em}",
                            "metadata": {
                                "service_name": dom,
                                "service_type": "registered_service",
                                "email": em,
                                **({"recovery_hint": str(item["emailrecovery"])} if item.get("emailrecovery") else {}),
                                **({"phone_hint": str(item["phoneNumber"])} if item.get("phoneNumber") else {}),
                            },
                            "summary": f"Holehe confirmed {em} is registered on {dom}{extra_txt}.",
                        }
                    )
                # SC-8: surface per-email partial progress so a later timeout still
                # leaves the analyst with the hits already found.
                if len(target_emails) > 1 and checked_idx < len(target_emails):
                    emit(
                        {
                            "kind": "tool_status",
                            "tool": name,
                            "state": "running",
                            "hits": emitted,
                            "detail": f"{emitted} service(s) so far — checked {checked_idx}/{len(target_emails)} email(s){proxy_label}",
                        }
                    )
            emit(
                {
                    "kind": "tool_status",
                    "tool": name,
                    "state": "done",
                    "hits": emitted,
                    "detail": f"{emitted} registered service(s) across {len(target_emails)} email(s)",
                }
            )

        # -----------------------------------------------------------------
        # 3. ignorant — Direct in-process Trio + httpx (socksio) with 18s cap
        # -----------------------------------------------------------------
        elif name == "ignorant":
            target_phones: list[tuple[str, str, str]] = []
            seen_phones: set[str] = set()
            for ph in phones:
                if ph in seen_phones:
                    continue
                parsed_ph = parse_phone_cc_number(ph)
                if parsed_ph:
                    seen_phones.add(ph)
                    target_phones.append((ph, parsed_ph[0], parsed_ph[1]))
            target_phones = target_phones[: (2 if depth_level >= 3 else 1)]
            if not target_phones:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "needs phone"})
                return
            _, first_cc, first_num = target_phones[0]
            emit({"kind": "tool_status", "tool": name, "state": "running", "hits": 0, "detail": f"Checking +{first_cc}•••{first_num[-2:]}{proxy_label}"})
            emitted = 0
            seen_dom_phone: set[str] = set()
            for ph, cc, num in target_phones:
                found_hits = run_ignorant_direct(cc, num, active_proxy)
                for item in found_hits:
                    dom = str(item.get("domain") or item.get("name") or "").strip()
                    key = f"{dom}:{ph}"
                    if not dom or key in seen_dom_phone:
                        continue
                    seen_dom_phone.add(key)
                    emitted += 1
                    emit(
                        {
                            "kind": "finding",
                            "tool": name,
                            "entity_kind": "service",
                            "label": f"{dom} (Phone)",
                            "category": "service",
                            "confidence": 0.86,
                            "match_tier": "verified",
                            "match_reason": f"Phone registered service for {ph} (ignorant)",
                            "metadata": {
                                "service_name": dom,
                                "service_type": "phone_service",
                                "phone": ph,
                            },
                            "summary": f"Ignorant confirmed {ph} is registered on {dom}.",
                        }
                    )
            emit({"kind": "tool_status", "tool": name, "state": "done", "hits": emitted, "detail": f"{emitted} phone service(s)"})

        # -----------------------------------------------------------------
        # 4. maigret — Multi-handle parallel check + `--proxy socks5h://...`
        # -----------------------------------------------------------------
        elif name == "maigret":
            target_handles = unique_handles[:handle_scan_limit]
            if not target_handles:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "needs handle"})
                return
            emit(
                {
                    "kind": "tool_status",
                    "tool": name,
                    "state": "running",
                    "hits": 0,
                    "detail": f"Deep profile check for {', '.join('@' + h for h in target_handles)}{proxy_label}",
                }
            )

            def _scan_maigret_handle(
                h: str,
            ) -> tuple[list[tuple[str, dict[str, Any]]], int, list[str]]:
                argv = [
                    "maigret", h,
                    "--top-sites", maigret_top,
                    "--timeout", "8",
                    "--no-progressbar", "--no-color", "--no-autoupdate",
                ]
                if active_proxy:
                    argv.extend(["--proxy", active_proxy])
                code = f"import sys; sys.argv = {json.dumps(argv)}; from maigret.maigret import run; run()"
                # CRITICAL: clean env with NO ALL_PROXY so aiohttp_socks uses --proxy socks5h:// cleanly!
                rc, lines = stream_python_code(code, build_clean_env(None), timeout=maigret_timeout)
                return ([(h, item) for item in parse_maigret_lines(lines)], rc, lines)

            scan_batches = (
                [_scan_maigret_handle(target_handles[0])]
                if len(target_handles) == 1
                else []
            )
            if len(target_handles) > 1:
                with ThreadPoolExecutor(max_workers=len(target_handles)) as hpool:
                    scan_batches = list(hpool.map(_scan_maigret_handle, target_handles))

            raw_results: list[tuple[str, dict[str, Any]]] = []
            scan_failures: list[tuple[int, list[str]]] = []
            for batch_hits, rc, lines in scan_batches:
                raw_results.extend(batch_hits)
                if rc != 0:
                    scan_failures.append((rc, lines))

            prepared: list[tuple[int, dict[str, Any]]] = []
            seen_urls: set[str] = set()
            for h, item in raw_results:
                attrs = item["attrs"]
                site = item["site"]
                url = item["url"]
                u_key = url.lower().rstrip("/")
                if is_blocked_spa_url(url) or is_feed_or_asset_url(url) or u_key in seen_urls:
                    continue
                seen_urls.add(u_key)

                ext_fullname = attrs.get("fullname") or attrs.get("name") or ""
                loc = attrs.get("location") or ""
                org = attrs.get("company") or attrs.get("organization") or ""
                bio = attrs.get("bio") or ""
                img = attrs.get("image") or ""
                uid = attrs.get("uid") or ""

                if ext_fullname:
                    if fullname_matches(ext_fullname, full_name):
                        tier, conf, reason, rank = "verified", 0.88, f"Maigret confirmed name ({ext_fullname})", 0
                    else:
                        tier, conf, reason, rank = "collision", 0.34, f"Name mismatch ({ext_fullname}) — collision", 2
                else:
                    tier, conf, reason, rank = "probable", 0.64, "Maigret profile match", 1

                summary_bits = []
                if ext_fullname:
                    summary_bits.append(f"Name: {ext_fullname}")
                if org:
                    summary_bits.append(f"Org: {org}")
                if loc:
                    summary_bits.append(f"Location: {loc}")
                if bio:
                    summary_bits.append(f"Bio: {bio[:110]}")
                if uid:
                    summary_bits.append(f"UID: {uid}")
                summary = " · ".join(summary_bits) if summary_bits else f"Maigret matched {site} profile at {url}."

                meta: dict[str, str] = {
                    "platform": site,
                    "handle": h,
                }
                if ext_fullname:
                    meta["display_name"] = ext_fullname
                if bio:
                    meta["bio"] = bio[:200]
                if loc:
                    meta["location"] = loc
                if org:
                    meta["org"] = org
                if img:
                    meta["avatar_url"] = img
                if uid:
                    meta["uid"] = uid

                prepared.append(
                    (
                        rank,
                        {
                            "kind": "finding",
                            "tool": name,
                            "entity_kind": "account",
                            "label": f"{site} ({h})",
                            "url": url,
                            "category": "code" if site.lower() in ("github", "githubgist", "gitlab", "pypi", "dockerhub") else "account",
                            "confidence": conf,
                            "match_tier": tier,
                            "match_reason": reason,
                            "metadata": meta,
                            "summary": summary,
                        },
                    )
                )

            prepared.sort(key=lambda x: x[0])
            cap = 28 if depth_level >= 4 else 22
            emitted_items = [ev for _, ev in prepared[:cap]]
            for ev in emitted_items:
                emit(ev)
            # Never report a killed/failed scan as a clean 0-hit run; keep the
            # parsed hits above and surface a short error tail instead.
            if scan_failures:
                rc, lines = scan_failures[0]
                tail = " | ".join(strip_ansi(ln).strip() for ln in lines[-2:] if ln.strip())
                failed = (
                    f" ({len(scan_failures)}/{len(target_handles)} handle(s) failed)"
                    if len(target_handles) > 1
                    else ""
                )
                emit(
                    {
                        "kind": "tool_status",
                        "tool": name,
                        "state": "error",
                        "hits": len(emitted_items),
                        "detail": f"maigret rc={rc}{failed}: {tail or 'no output'}"[:400],
                    }
                )
                return
            emit({"kind": "tool_status", "tool": name, "state": "done", "hits": len(emitted_items), "detail": f"{len(emitted_items)} profile hit(s) across {len(target_handles)} handle(s)"})

        # -----------------------------------------------------------------
        # 5. sherlock — Multi-handle curated high-signal sites via --local + socks5h://
        # -----------------------------------------------------------------
        elif name == "sherlock":
            target_handles = unique_handles[:handle_scan_limit]
            if not target_handles:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "needs handle"})
                return
            sites_slice = SHERLOCK_HIGH_SIGNAL_SITES[:sherlock_count]
            emit(
                {
                    "kind": "tool_status",
                    "tool": name,
                    "state": "running",
                    "hits": 0,
                    "detail": f"Checking {', '.join('@' + h for h in target_handles)} across {len(sites_slice)} sites{proxy_label}",
                }
            )

            def _scan_sherlock_handle(
                h: str,
            ) -> tuple[list[tuple[str, str, str]], int, list[str]]:
                argv = ["sherlock", h, "--local", "--timeout", "6", "--print-found", "--no-color"]
                if active_proxy:
                    argv.extend(["--proxy", active_proxy])
                for s in sites_slice:
                    argv.extend(["--site", s])
                code = f"import sys; sys.argv = {json.dumps(argv)}; from sherlock_project.sherlock import main; main()"
                rc, lines = stream_python_code(code, build_clean_env(None), timeout=sherlock_timeout)
                out_hits: list[tuple[str, str, str]] = []
                for raw in lines:
                    ln = strip_ansi(raw).strip()
                    m = re.match(r"^\[\+\]\s+([^:]+):\s+(https?://\S+)", ln)
                    if m:
                        site = m.group(1).strip()
                        u = m.group(2).strip()
                        if not is_blocked_spa_url(u) and not is_feed_or_asset_url(u):
                            out_hits.append((h, site, u))
                return (out_hits, rc, lines)

            scan_batches = (
                [_scan_sherlock_handle(target_handles[0])]
                if len(target_handles) == 1
                else []
            )
            if len(target_handles) > 1:
                with ThreadPoolExecutor(max_workers=len(target_handles)) as hpool:
                    scan_batches = list(hpool.map(_scan_sherlock_handle, target_handles))

            raw_hits: list[tuple[str, str, str]] = []
            scan_failures: list[tuple[int, list[str]]] = []
            for batch_hits, rc, lines in scan_batches:
                raw_hits.extend(batch_hits)
                if rc != 0:
                    scan_failures.append((rc, lines))

            hits: list[tuple[str, str, str]] = []
            seen_u: set[str] = set()
            for h, site, u in raw_hits:
                u_key = u.lower().rstrip("/")
                if u_key not in seen_u:
                    seen_u.add(u_key)
                    hits.append((h, site, u))

            cap = 28 if depth_level >= 4 else 22
            for h, site, u in hits[:cap]:
                emit(
                    {
                        "kind": "finding",
                        "tool": name,
                        "entity_kind": "account",
                        "label": f"{site} ({h})",
                        "url": u,
                        "category": "code" if site.lower() in ("github", "gitlab", "pypi", "npm", "docker hub", "dockerhub", "bitbucket", "kaggle", "codepen", "hackerone", "pastebin", "replit.com") else "account",
                        "confidence": 0.66,
                        "match_tier": "probable",
                        "match_reason": "Sherlock cross-engine match",
                        "metadata": {
                            "platform": site,
                            "handle": h,
                        },
                        "summary": f"Sherlock confirmed active {site} account for @{h} at {u}.",
                    }
                )
            # Same contract as maigret: keep parsed hits, but never report a
            # failed subprocess as a clean 0-hit run.
            if scan_failures:
                rc, lines = scan_failures[0]
                tail = " | ".join(strip_ansi(ln).strip() for ln in lines[-2:] if ln.strip())
                failed = (
                    f" ({len(scan_failures)}/{len(target_handles)} handle(s) failed)"
                    if len(target_handles) > 1
                    else ""
                )
                emit(
                    {
                        "kind": "tool_status",
                        "tool": name,
                        "state": "error",
                        "hits": len(hits[:cap]),
                        "detail": f"sherlock rc={rc}{failed}: {tail or 'no output'}"[:400],
                    }
                )
                return
            emit({"kind": "tool_status", "tool": name, "state": "done", "hits": len(hits[:cap]), "detail": f"{len(hits[:cap])} profile hit(s) across {len(target_handles)} handle(s)"})

        # -----------------------------------------------------------------
        # 6. socid-extractor — Direct in-process structured profile attribute enrichment
        # -----------------------------------------------------------------
        elif name == "socid-extractor":
            if not profile_urls:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "0 confirmed URLs"})
                return
            emit({"kind": "tool_status", "tool": name, "state": "running", "hits": 0, "detail": f"Extracting structured attributes from {min(socid_limit, len(profile_urls))} profile(s)"})
            hits = 0
            try:
                import requests
                import socid_extractor

                proxies = {"http": active_proxy, "https": active_proxy} if active_proxy else None
                headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                for u in profile_urls[:socid_limit]:
                    if is_blocked_spa_url(u):
                        continue
                    try:
                        resp = requests.get(u, headers=headers, proxies=proxies, timeout=8)
                        if resp.status_code != 200:
                            continue
                        extracted = socid_extractor.extract(resp.text)
                        if extracted:
                            meta: dict[str, str] = {}
                            if extracted.get("fullname") or extracted.get("name"):
                                meta["display_name"] = str(extracted.get("fullname") or extracted.get("name"))[:120]
                            if extracted.get("bio") or extracted.get("about"):
                                meta["bio"] = str(extracted.get("bio") or extracted.get("about"))[:220]
                            if extracted.get("location"):
                                meta["location"] = str(extracted["location"])[:100]
                            if extracted.get("work") or extracted.get("company"):
                                meta["org"] = str(extracted.get("work") or extracted.get("company"))[:100]
                            if extracted.get("image"):
                                meta["avatar_url"] = str(extracted["image"])
                            if extracted.get("uid") or extracted.get("id"):
                                meta["uid"] = str(extracted.get("uid") or extracted.get("id"))
                            pairs = [f"{k}: {str(v)[:65]}" for k, v in list(extracted.items())[:6] if v]
                            if not meta and not pairs:
                                continue
                            hits += 1
                            emit(
                                {
                                    "kind": "finding",
                                    "tool": name,
                                    "entity_kind": "enrichment",
                                    "label": f"Structured Profile ({urlparse(u).netloc.replace('www.', '')})",
                                    "url": u,
                                    "category": "anchor",
                                    "confidence": 0.84,
                                    "match_tier": "verified",
                                    "match_reason": "socid-extractor structured metadata",
                                    "metadata": meta,
                                    "summary": " · ".join(pairs),
                                }
                            )
                    except Exception:
                        continue
            except Exception as exc:
                emit({"kind": "tool_status", "tool": name, "state": "error", "hits": 0, "detail": str(exc)[:80]})
                return
            emit({"kind": "tool_status", "tool": name, "state": "done", "hits": hits, "detail": f"{hits} profile(s) enriched"})

        # -----------------------------------------------------------------
        # 7. onionsearch — Patched live v3 .onion search over local Tor SOCKS5
        # -----------------------------------------------------------------
        elif name == "onionsearch":
            if not enable_tor:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "Tor toggle OFF"})
                return
            if not active_proxy:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "Tor offline"})
                return
            # Prefer high-specificity verified self-audit anchors when present, else full_name / handle
            raw_query = primary_email or primary_domain or full_name or primary_handle
            if not raw_query:
                emit({"kind": "tool_status", "tool": name, "state": "skipped", "hits": 0, "detail": "needs search term"})
                return
            if raw_query == full_name and len(full_name.split()) > 1 and not (full_name.startswith('"') and full_name.endswith('"')):
                query = f'"{full_name}"'
            else:
                query = raw_query
            p_url = urlparse(active_proxy)
            proxy_hp = f"{p_url.hostname or '127.0.0.1'}:{p_url.port or 9050}"
            v3_engines = ["onionland", "phobos", "tor66", "haystack"] if depth_level >= 3 else ["onionland", "phobos", "tor66"]
            emit({"kind": "tool_status", "tool": name, "state": "running", "hits": 0, "detail": f"Querying {len(v3_engines)} live v3 .onion indexes via {proxy_hp}"})
            tmp_csv = os.path.join(tempfile.gettempdir(), f"tauf_os_{os.getpid()}_{int(time.time()*1000)}.csv")
            argv = [
                "onionsearch",
                query,
                "--proxy",
                proxy_hp,
                "--continuous_write",
                "True",
                "--mp_units",
                str(len(v3_engines)),
                "--engines",
                *v3_engines,
                "--limit",
                "1",
                "--output",
                tmp_csv,
            ]
            code = f"""
import sys
sys.argv = {json.dumps(argv)}
try:
    import onionsearch.core as oc
    oc.ENGINES["ahmia"] = {json.dumps(LIVE_AHMIA_V3)}
    oc.ENGINES["onionland"] = {json.dumps(LIVE_ONIONLAND_V3)}
    oc.scrape()
except Exception as exc:
    print("TAUF_ONIONSEARCH_ERROR:" + repr(exc)[:300])
    raise SystemExit(3)
"""
            # SC-5: onionsearch needs ~45 s to write its CSV over a cold circuit.
            rc, lines = stream_python_code(code, build_clean_env(None), timeout=45)
            patch_error = ""
            for ln in reversed(lines):
                if ln.startswith("TAUF_ONIONSEARCH_ERROR:"):
                    patch_error = ln[len("TAUF_ONIONSEARCH_ERROR:") :].strip()
                    break
            found_onions: list[tuple[str, str, str]] = []
            seen_o = set()
            engine_self_hosts = (
                "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd",
                "3bbad7fauom4d6sgppalyqddsqbf5u5p56b5k5uk2zxsy3d6ey2jobad",
                "phobosxilamwcg75xt22id7aywkzol6q6rfl2flipcqoc4e4ahima5id",
                "tor66sewebgixwhcqfnp5inzp5x5uohhdy3kvtnyfxc2e5mxiuh34iid",
                "haystak5njsmn2hqkewecpaxetahtwhsbsa64jom2k22z5afxhnpxfid",
            )
            try:
                if os.path.exists(tmp_csv):
                    try:
                        with open(tmp_csv, "r", encoding="utf-8", errors="ignore") as f:
                            for row in csv.reader(f):
                                if len(row) >= 3 and ".onion" in row[2]:
                                    sub_eng = row[0].strip() or "onionsearch"
                                    title = row[1].strip() or "Tor Hidden Service"
                                    url = row[2].strip()
                                    if url not in seen_o and not any(eh in url for eh in engine_self_hosts):
                                        seen_o.add(url)
                                        found_onions.append((sub_eng, title, url))
                    except Exception:
                        pass
            finally:
                try:
                    if os.path.exists(tmp_csv):
                        os.remove(tmp_csv)
                except Exception:
                    pass
            for sub_eng, title, o in found_onions[:10]:
                emit(
                    {
                        "kind": "finding",
                        "tool": name,
                        "entity_kind": "onion",
                        "label": title[:52],
                        "url": o,
                        "category": "darkweb",
                        "confidence": 0.72,
                        "match_tier": "probable",
                        "match_reason": f"OnionSearch ({sub_eng}) live v3 .onion hit",
                        "metadata": {
                            "engine": f"onionsearch:{sub_eng}",
                            "matched_term": raw_query,
                            "search_query": query,
                        },
                        "summary": f"OnionSearch ({sub_eng}) over Tor SOCKS5h returned '{title}' at {o}.",
                    }
                )
            # SC-5: never report a killed/failed crawl with 0 hits or patch error as a clean run.
            if rc != 0 and (patch_error or rc != 124 or not found_onions):
                tail = " | ".join(strip_ansi(ln).strip() for ln in lines[-3:] if ln.strip())
                if patch_error:
                    detail = f"onionsearch monkey-patch/scrape failed: {patch_error}"
                else:
                    detail = f"onionsearch rc={rc}: {tail or 'no output'}"
                emit(
                    {
                        "kind": "tool_status",
                        "tool": name,
                        "state": "error",
                        "hits": len(found_onions[:10]),
                        "detail": detail[:400],
                    }
                )
                return
            suffix = " (partial before timeout)" if rc == 124 else ""
            emit({"kind": "tool_status", "tool": name, "state": "done", "hits": len(found_onions[:10]), "detail": f"{len(found_onions[:10])} .onion hit(s) across {len(v3_engines)} v3 engine(s){suffix}"})

    def _safe_run_one(spec: dict[str, Any]) -> None:
        name = spec["name"]
        try:
            _run_one(spec)
        except Exception as exc:
            emit(
                {
                    "kind": "tool_status",
                    "tool": name,
                    "state": "error",
                    "hits": 0,
                    "detail": str(exc)[:120],
                }
            )
            return
        if name not in _TERMINAL_EMITTED:
            emit(
                {
                    "kind": "tool_status",
                    "tool": name,
                    "state": "error",
                    "hits": 0,
                    "detail": "no terminal status emitted",
                }
            )

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_safe_run_one, spec): spec["name"] for spec in TOOL_CATALOG}
        for fut in as_completed(futures):
            name = futures[fut]
            exc = fut.exception()
            if exc is not None:
                emit(
                    {
                        "kind": "tool_status",
                        "tool": name,
                        "state": "error",
                        "hits": 0,
                        "detail": str(exc)[:120],
                    }
                )


def main() -> int:
    parser = argparse.ArgumentParser(description="TAUF Local Open-Source Sidecar Bridge V3")
    parser.add_argument("--probe", action="store_true", help="Output JSON inventory of local OSS tools")
    parser.add_argument("--run", action="store_true", help="Run available local OSS tools and stream JSONL")
    parser.add_argument("--payload", type=str, default=None, help="JSON payload for --run (or send it on stdin)")
    args = parser.parse_args()

    if args.probe:
        sys.stdout.write(json.dumps(probe_tools(), ensure_ascii=False))
        sys.stdout.flush()
        return 0

    if args.run:
        # SC-7: prefer an explicit --payload, otherwise read the JSON document
        # from stdin (Node writes the payload there and closes the pipe).
        raw = args.payload or ""
        if not raw.strip() and not sys.stdin.isatty():
            try:
                raw = sys.stdin.read()
            except Exception:
                raw = ""
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        run_sidecar(payload)
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
