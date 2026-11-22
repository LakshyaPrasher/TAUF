const EMAIL_RE = /\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const PHONE_RE = /(?<!\w)(\+?\d[\d\s\-().]{7,18}\d)(?!\w)/g;
const ONION_RE = /\b([a-z2-7]{16,56})\.onion\b/gi;
const PGP_RE = /\b([0-9A-Fa-f]{16,40})\b/g;

function maskEmail(local: string, domain: string): string {
  const head = local.slice(0, 2);
  const parts = domain.split(".");
  const dHead = parts[0]?.slice(0, 2) ?? "••";
  const tld = parts.length > 1 ? `.${parts[parts.length - 1]}` : "";
  return `${head}•••@${dHead}•••${tld}`;
}

function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return raw;
  const tail = digits.slice(-2);
  return `•••-•••-••${tail}`;
}

function maskOnion(addr: string): string {
  return `${addr.slice(0, 6)}••••••••.onion`;
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("@")) {
    const [local, domain] = trimmed.split("@");
    return maskEmail(local ?? "", domain ?? "");
  }
  if (trimmed.length <= 4) return "••••";
  return `${trimmed.slice(0, 2)}${"•".repeat(Math.min(8, Math.max(4, trimmed.length - 4)))}${trimmed.slice(-2)}`;
}

export function redactText(
  text: string,
  enabled: boolean,
  extraSensitive: string[] = []
): string {
  if (!enabled || !text) return text;

  let out = text;

  for (const raw of extraSensitive) {
    const token = raw.trim();
    if (token.length < 3) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), maskToken(token));
  }

  out = out.replace(EMAIL_RE, (_m, local: string, domain: string) =>
    maskEmail(local, domain)
  );
  out = out.replace(ONION_RE, (_m, addr: string) => maskOnion(addr));
  out = out.replace(PHONE_RE, (m) => maskPhone(m));
  out = out.replace(PGP_RE, (m) => {
    if (m.length >= 16) {
      return `${m.slice(0, 4)}••••••••${m.slice(-4)}`;
    }
    return m;
  });

  return out;
}

export function redactNodeLabel(
  label: string,
  kind: string,
  enabled: boolean
): string {
  if (!enabled) return label;
  const lowerKind = kind.toLowerCase();
  if (
    lowerKind === "email" ||
    lowerKind === "phone" ||
    lowerKind === "breach" ||
    lowerKind === "corpus_hit" ||
    lowerKind === "darkweb" ||
    lowerKind === "onion" ||
    lowerKind === "pgp" ||
    lowerKind === "gpg_key" ||
    lowerKind === "ssh_key"
  ) {
    return redactText(label, true, [label]);
  }
  return redactText(label, true);
}

export function isSensitiveMetadataKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("email") ||
    k.includes("phone") ||
    k.includes("key") ||
    k.includes("fingerprint") ||
    k.includes("breach") ||
    k.includes("corpus") ||
    k.includes("excerpt") ||
    k.includes("onion") ||
    k.includes("hash") ||
    k.includes("uid")
  );
}
