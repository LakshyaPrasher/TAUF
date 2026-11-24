# TAUF

**Sovereign local OSINT & digital-footprint exposure workbench** — discover, verify, visualize, and audit public clearnet records, social/developer accounts, cryptographic keys, public documents, registered services, offline breach corpora, and Tor `.onion` hidden-service mentions **100% locally with zero external SaaS APIs or API keys**.

## Key Capabilities

- **18 Local Protocol & Open-Source Engines:** 11 native direct-protocol engines (multi-engine HTML search cascade, 70-site canary-calibrated WhatsMyName sweep, raw Git `.patch`/`.gpg`/`.keys`, OpenPGP HKP, DNS MX/SPF/DMARC/TXT, port-443 TLS X.509 SANs, PDF byte-range metadata, JSON-LD `sameAs` / `rel="me"`, Ahmia v3 + OnionLand v3) paired with 7 local Python sidecar tools (`maigret`, `sherlock`, `socid-extractor`, `holehe`, `ignorant`, `h8mail`, `onionsearch`).
- **Strict Tor `socks5h://` Anonymity:** Remote DNS (`ATYP 0x03`), per-query RFC 1929 `IsolateSOCKSAuth` circuit isolation, and fail-closed `strict_anonymity` guard (zero local UDP DNS leakage).
- **Recursive Multi-Hop Frontier Engine (`V6.0`):** Priority-queue scheduler (`scripts/engine/{scheduler,pivots,search_pool,noise_guard}.mjs`) with sticky Tor circuit reuse, Startpage + DDG-Lite index union, non-destructive partial retention, and multi-hop recursive expansion across verified emails, Gravatar profiles, secondary handles, personal domains (`/about`, `/cv`, `/.well-known/*`), and `<Org>` context disambiguators.
- **Zero-Hallucination Entity Resolution:** Compound-only handle generation, strict anti-noise gates (empty Gists, Wikipedia non-biographies, and stranger collisions dropped), SHA-256 avatar & reciprocal-link corroboration, and `FALSE_POSITIVES = 0` synthetic canary verification.
- **Interactive Multi-Hop Workbench:** Single-view React + Cytoscape identity graph, budget-driven adaptive ETA engine (`L1–L4`), live SSE telemetry, PII redaction toggle, and standalone HTML dossier export.

## Quick Start

```powershell
# 1. Check local runtime & sidecar dependencies
node scripts/setup.mjs --check

# 2. Build frontend & verify portable bundle
npm run build
node scripts/verify-portable.mjs

# 3. Run the 11-suite automated verification harness
node tests/run-all.mjs

# 4. Launch silently (Windows: launch-tauf.vbs · macOS/Linux: ./launch-tauf.sh)
wscript.exe .\launch-tauf.vbs
```

## Architecture & Handoff

See [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for the complete architecture, IPC contract, security model, and portable packaging specification.
