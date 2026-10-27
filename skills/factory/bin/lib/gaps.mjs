// The agent-gap ledger: one JSON line per (repo, job, kind, specialty) where the factory
// had to fall back because no specialised agent existed.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Fail } from "./errors.mjs";
import { gapsFile, now } from "./paths.mjs";
import { isSymlink } from "./store.mjs";
import { PATTERNS, hasExactKeys, matches, nullable } from "./validate.mjs";

const INPUT_KEYS = ["kind", "specialty", "package", "fallback", "reason"];
const FALLBACK_RE = /^factory-[a-z0-9]+(-[a-z0-9]+){0,3}$/;
const MAX_REASONS = 5;

export function validateGapInput(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) throw new Fail(2, "invalid gap: keys");
  const rules = [
    ["kind", (v) => v === "builder" || v === "reviewer"],
    ["specialty", matches(PATTERNS.gap)],
    ["package", nullable(matches(PATTERNS.pkgId))],
    ["fallback", nullable(matches(FALLBACK_RE))],
    ["reason", matches(PATTERNS.note)]
  ];
  const bad = rules.find(([k, pred]) => !pred(input[k]));
  if (bad) throw new Fail(2, `invalid gap: ${bad[0]}`);
  return input;
}

export function readGaps(home) {
  const file = gapsFile(home);
  if (isSymlink(file)) throw new Fail(3, "symlink at gaps.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === "object" ? [entry] : [];
      } catch {
        return [];
      }
    });
}

const sameGap = (a, b) => a.repo === b.repo && a.job === b.job && a.kind === b.kind && a.specialty === b.specialty;

// Returns true when appended, false when it was already recorded.
export function appendGap(home, repo, job, input) {
  const entry = { date: now(), repo, job, ...validateGapInput(input) };
  if (readGaps(home).some((g) => sameGap(g, entry))) return false;
  appendFileSync(gapsFile(home), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return true;
}

const uniqueSorted = (list) => [...new Set(list)].sort();

export function groupGaps(entries) {
  const groups = new Map();
  entries.forEach((e) => {
    const key = `${e.kind}\u0000${e.specialty}`;
    groups.set(key, [...(groups.get(key) || []), e]);
  });
  return [...groups.values()]
    .map((list) => ({
      kind: list[0].kind,
      specialty: list[0].specialty,
      count: list.length,
      repos: uniqueSorted(list.map((e) => e.repo)),
      jobs: uniqueSorted(list.map((e) => `${e.repo}/${e.job}`)),
      lastSeen: list.map((e) => e.date).sort().at(-1),
      reasons: [...new Set(list.map((e) => e.reason))].slice(0, MAX_REASONS)
    }))
    .sort((a, b) => b.count - a.count || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}
