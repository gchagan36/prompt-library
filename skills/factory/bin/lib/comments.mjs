// Mechanical comment scan for the docs lens: finds tracker, process, and history
// references, unexplained TODOs, and commented-out code in the comment and doc lines a
// diff adds. Candidates only; the docs reviewer confirms each. Best effort by design:
// it reads `git diff -U0`, so a block comment opened in unchanged context is missed.
import { isSecretLine } from "./secrets.mjs";

const ext = (file) => {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base;
};

const SYNTAX = new Map([
  ...["js", "jsx", "ts", "tsx", "mjs", "cjs", "java", "kt", "kts", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs",
    "swift", "scala", "dart", "php", "groovy", "scss", "less"].map((e) => [e, { line: "//", block: ["/*", "*/"] }]),
  ["css", { block: ["/*", "*/"] }],
  ...["py", "pyi"].map((e) => [e, { line: "#", doc: true }]),
  ...["rb", "sh", "bash", "zsh", "fish", "pl", "r", "yaml", "yml", "toml", "tf", "ps1", "Dockerfile", "Makefile"]
    .map((e) => [e, { line: "#" }]),
  ...["sql", "lua", "hs"].map((e) => [e, { line: "--" }]),
  ...["html", "xml", "vue", "svelte"].map((e) => [e, { line: "//", block: ["<!--", "-->"] }])
]);
const DOC_EXTS = new Set(["md", "mdx", "rst", "txt", "adoc"]);
const CHANGELOG = /^(CHANGELOG|CHANGES|HISTORY|NEWS)(\.[a-z]+)?$/i;

const RULES = {
  tracker: [
    /(?:^|[\s(\[])#\d{1,6}\b/,
    /\bGH-\d+\b/i,
    /\b(?!(?:AC|UTF|SHA|ISO|AES|RFC|CVE|CWE|HTTP|TLS|SSL|PEP|RSA|ECMA|ES|IPV|X|MD)-)[A-Z][A-Z0-9]{1,9}-\d+\b/,
    /https?:\/\/(?:www\.)?(?:github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull|projects|discussions|milestone)|gitlab\.com\/\S+\/-\/(?:issues|merge_requests)|[\w-]+\.atlassian\.net|linear\.app|trello\.com|(?:[\w-]+\.)?notion\.(?:so|site)|(?:[\w-]+|app)\.slack\.com|docs\.google\.com|app\.asana\.com|app\.clickup\.com)/i,
    /\b(?:see|per|fixes|closes|resolves|refs?)\s+(?:the\s+)?(?:issue|ticket|pr|pull request|jira|card)\b/i,
    /\b(?:issue|ticket|pr)\s*#?\d+\b/i
  ],
  process: [
    /\bAC-\d+\b/,
    /\breview round\b/i,
    /\bround \d+ (?:fix|fixes|review)\b/i,
    /\bper (?:the )?spec\b/i,
    /\b(?:as|per) (?:the )?reviewers?\b/i,
    /\bfeedback #?\d+\b/i,
    /\b(?:spec|build-P\d)\.md\b/,
    /\bfactory job\b/i,
    /\bper (?:our |the )?(?:discussion|meeting|call|conversation|slack)\b/i,
    /\bas (?:discussed|agreed)\b/i
  ],
  history: [
    /\bpreviously\b/i,
    /\bused to\b/i,
    /\bchanged (?:from|to)\b/i,
    /\bno longer\b/i,
    /\bnow (?:uses|returns|supports|handles|calls|accepts|requires)\b/i,
    /^\s*new:/i,
    /\b(?:added|introduced|removed) in (?:this|the latest) (?:change|pr|commit|version|release)\b/i,
    /\btemporary (?:fix|workaround|hack)\b/i
  ]
};
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s(]*(.*)$/;
const CODE_RE = [
  /^(?:const|let|var|return|import|export|def|class|function|if|for|while|print|await|elif|else)\b.*[;{}():=]/,
  /^console\.\w+\(/,
  /[=(].*[;{]\s*$/,
  /^[\w.]+\(.*\);?$/
];
const SKIP_LINE = /SPDX-License-Identifier|Copyright \(c\)|^#!/i;

// Index of `marker` outside string quotes, at the start or after whitespace; -1 if none.
export function markerIndex(text, marker) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (text.startsWith(marker, i) && (i === 0 || /\s/.test(text[i - 1]))) {
      return i;
    }
  }
  return -1;
}

// Comment text of one added line, tracking open block comments and docstrings in `st`.
export function commentOf(syntax, text, st) {
  if (st.close) {
    const end = text.indexOf(st.close);
    if (end >= 0) st.close = null;
    return end >= 0 ? text.slice(0, end) : text;
  }
  if (syntax.doc) {
    const t = text.trim().replace(/^[rbuf]+(?=["'])/i, "");
    const delim = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (delim) {
      const rest = t.slice(3);
      if (!rest.includes(delim)) st.close = delim;
      return rest.split(delim)[0];
    }
  }
  if (syntax.block) {
    const [open, close] = syntax.block;
    const i = markerIndex(text, open);
    if (i >= 0) {
      const rest = text.slice(i + open.length);
      if (!rest.includes(close)) st.close = close;
      return rest.split(close)[0];
    }
  }
  if (syntax.line) {
    const i = markerIndex(text, syntax.line);
    if (i >= 0) return text.slice(i + syntax.line.length);
  }
  return null;
}

// Rule hits in one comment (or doc) text: [{ rule, match }].
export function scanText(text, { docs = false, changelog = false } = {}) {
  const clean = text.replace(/^[\s*/#!-]+/, "").trim();
  if (clean.length === 0 || SKIP_LINE.test(text)) return [];
  const families = docs ? (changelog ? ["process"] : ["tracker", "process"]) : ["tracker", "process", "history"];
  // One hit per rule family: the first pattern that matches.
  const hits = families.flatMap((rule) => {
    const m = RULES[rule].map((re) => re.exec(clean)).find(Boolean);
    return m ? [{ rule, match: m[0].trim() }] : [];
  });
  if (docs) return hits;
  const todo = TODO_RE.exec(clean);
  const todoWords = todo ? todo[2].replace(/#\d+|\b[A-Z]+-\d+\b/g, "").split(/\s+/).filter(Boolean).length : 0;
  const extra = [
    ...(todo && todoWords < 4 ? [{ rule: "todo", match: clean }] : []),
    ...(CODE_RE.some((re) => re.test(clean)) ? [{ rule: "commented-code", match: clean }] : [])
  ];
  return [...hits, ...extra];
}

// Added lines of a `git diff -U0` as [{ file, line, text }].
export function addedLines(diff) {
  const out = [];
  let file = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) file = raw === "+++ /dev/null" ? null : raw.slice(6);
    else if (raw.startsWith("@@")) next = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    else if (raw.startsWith("+") && file !== null) out.push({ file, line: next++, text: raw.slice(1) });
  }
  return out;
}

// All candidates in a diff, with what was and wasn't scanned.
export function scanDiff(diff) {
  const states = new Map();
  const skipped = new Set();
  let scanned = 0;
  const candidates = addedLines(diff).flatMap(({ file, line, text }) => {
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (DOC_EXTS.has(ext(file))) {
      scanned += 1;
      return scanText(text, { docs: true, changelog: CHANGELOG.test(base) }).map((h) => ({ file, line, ...h }));
    }
    const syntax = SYNTAX.get(ext(file));
    if (!syntax) {
      skipped.add(file);
      return [];
    }
    if (!states.has(file)) states.set(file, { close: null });
    const comment = commentOf(syntax, text, states.get(file));
    if (comment === null) return [];
    scanned += 1;
    return scanText(comment).map((h) => ({ file, line, ...h }));
  });
  return { candidates, scanned, skipped: [...skipped] };
}

const MAX_ROWS = 200;
const cell = (s) => (isSecretLine(s) ? "possible secret" : s.replace(/[^\x20-\x7e]/g, "?").replace(/[`|]/g, "'").slice(0, 80));

export function renderScan({ candidates, scanned, skipped }, { round, base, head }) {
  const files = new Set(candidates.map((c) => c.file));
  const rows = candidates.slice(0, MAX_ROWS).map((c) => `| \`${cell(`${c.file}:${c.line}`)}\` | ${c.rule} | \`${cell(c.match)}\` |`);
  return [
    `# Comment scan: round ${round}`,
    "",
    `Candidates found mechanically in the comment and doc lines added between \`${base.slice(0, 7)}\` and \`${head.slice(0, 7)}\`.`,
    "Confirm each against the docs lens rules and drop false positives. The scan knows common comment",
    "syntaxes only, so it is a floor, not a ceiling: still read the diff.",
    "",
    `Scanned ${scanned} comment or doc lines. Candidates: ${candidates.length} in ${files.size} files.`,
    ...(skipped.length > 0 ? [`Not scanned (unknown syntax): ${skipped.slice(0, 20).map((f) => `\`${cell(f)}\``).join(", ")}.`] : []),
    ...(candidates.length > MAX_ROWS ? [`Showing the first ${MAX_ROWS}.`] : []),
    "",
    ...(rows.length > 0 ? ["| Where | Rule | Match |", "|---|---|---|", ...rows] : ["No candidates."]),
    ""
  ].join("\n");
}
