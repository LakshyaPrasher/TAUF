// Helper for the TAUF unit/verification suite.
//
// local-server.mjs is a single top-level module with no exports, so the tests
// extract the real function bodies from the source text and rebuild them with
// `new Function`. This keeps the tests honest: they exercise the shipped code
// rather than a copy of it.
//
// Unlike the naive brace walker in phase2-verify.mjs, this scanner skips
// string/template literals, comments and regex literals. That matters because
// parseSearchResults() contains `/\{[^}]*\}/` style patterns whose braces are
// not code blocks, and a naive counter would truncate the function early.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_PATH = path.resolve(here, "..", "..", "local-server.mjs");
export const source = fs.readFileSync(SERVER_PATH, "utf8");

const REGEX_PREFIX_CHARS = new Set([
  "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">",
]);
const REGEX_PREFIX_WORDS = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await",
]);

function regexCanStart(src, slashIndex) {
  let prev = "";
  for (let i = slashIndex - 1; i >= 0; i--) {
    if (!/\s/.test(src[i])) {
      prev = src[i];
      break;
    }
  }
  if (!prev) return true;
  if (REGEX_PREFIX_CHARS.has(prev)) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    const word = (src.slice(0, slashIndex).match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
    return Boolean(word && REGEX_PREFIX_WORDS.has(word));
  }
  return false;
}

/**
 * Extract a top-level `function NAME(...) { ... }` (including the `async`
 * modifier when present) by matching braces.
 *
 * @param {string} src  full source text of local-server.mjs
 * @param {string} name function identifier
 * @returns {string} the exact source slice for the function declaration
 */
export function extractFn(src, name) {
  if (typeof src !== "string" || typeof name !== "string" || !name) {
    throw new Error("extractFn(src, name) requires a source string and a function name");
  }
  const declRe = new RegExp(
    `(^|[\\n;}])\\s*((?:async\\s+)?function\\s+${name.replace(/\$/g, "\\$")}\\s*\\()`,
    "m"
  );
  const decl = declRe.exec(src);
  if (!decl) throw new Error(`extractFn: function ${name} not found in source`);
  const start = decl.index + decl[1].length;

  let i = start;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) throw new Error(`extractFn: no body found for ${name}`);

  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === "/" && regexCanStart(src, i)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        i++;
      }
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extractFn: unbalanced braces for ${name}`);
}

/**
 * Extract a top-level `const NAME = ... ;` declaration (or let/var), e.g.
 * PLATFORM_SLUG_ALIASES. Useful for feeding real lookup tables into the
 * sandbox instead of re-typing them in tests.
 *
 * @param {string} src  full source text
 * @param {string} name constant identifier
 * @returns {string} the exact source slice, including the trailing semicolon
 */
export function extractConst(src, name) {
  const declRe = new RegExp(`(^|[\\n;])\\s*(?:const|let|var)\\s+${name}\\s*=`, "m");
  const decl = declRe.exec(src);
  if (!decl) throw new Error(`extractConst: ${name} not found in source`);
  const start = decl.index + decl[1].length;
  let i = src.indexOf("=", start) + 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`extractConst: unterminated declaration for ${name}`);
}

/**
 * Build a live sandbox containing the real extracted function bodies.
 *
 * @param {string[]} names function names to extract, in dependency order (order
 *   does not actually matter: function declarations are hoisted inside the
 *   generated function scope).
 * @param {object|string} [extraArgs] object of free-variable name -> value
 *   (passed as `new Function` parameters, e.g. `{ crypto, path, os,
 *   FREE_MAIL_DOMAINS }`), or a plain source string of declarations.
 * @param {string} [preludeSource] extra source declarations (e.g. a real const
 *   table extracted with extractConst) inserted before the function bodies.
 * @returns {Record<string, Function>}
 */
export function makeApi(names, extraArgs = {}, preludeSource = "") {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("makeApi(names, extraArgs) requires a non-empty array of names");
  }
  const params = [];
  const values = [];
  const prelude = [];

  if (preludeSource) prelude.push(preludeSource);
  if (typeof extraArgs === "string") {
    prelude.push(extraArgs);
  } else if (extraArgs && typeof extraArgs === "object") {
    for (const [key, value] of Object.entries(extraArgs)) {
      params.push(key);
      values.push(value);
    }
  } else {
    throw new Error("makeApi: extraArgs must be an object or a source string");
  }

  const bodies = names.map((name) => extractFn(source, name)).join("\n\n");
  const factory = new Function(
    ...params,
    `${prelude.join("\n")}\n${bodies}\nreturn { ${names.join(", ")} };`
  );
  return factory(...values);
}

export default { extractFn, extractConst, makeApi, source, SERVER_PATH };
