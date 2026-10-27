// Field patterns and whole-state validation for state.json (references/state.md).
import { Fail } from "./errors.mjs";
import { worktreeDir } from "./paths.mjs";

export const PATTERNS = Object.freeze({
  id: /^[0-9]{3}(-i[0-9]+)?(-[a-z0-9]+){1,4}$/,
  repo: /^[a-z0-9-]{1,40}-[0-9a-f]{8}$/,
  slug: /^[a-z0-9]+(-[a-z0-9]+){0,3}$/,
  title: /^[A-Za-z0-9 ,.()#/-]{1,60}$/,
  target: /^[A-Za-z0-9._/-]{1,100}$/,
  sha: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
  token: /^[0-9a-f]{32}$/,
  pkgId: /^P[1-9]$/,
  agent: /^factory-builder(-[a-z0-9]+){0,3}$/,
  gap: /^[a-z0-9]+(-[a-z0-9]+){0,3}$/,
  lens: /^[a-z0-9]+(-[a-z0-9]+){0,2}$/,
  tag: /^[a-z0-9]+(-[a-z0-9]+){0,2}$/,
  pr: /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/,
  note: /^[A-Za-z0-9 ,.:;()#/_+=@-]{1,160}$/,
  stamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
});

export const NOTE_UNSAFE = /[^A-Za-z0-9 ,.:;()#/_+=@-]/g;
export const WORKING = Object.freeze(["spec", "build", "review", "approve"]);
export const RESTING = Object.freeze(["signoff", "needs-human", "pr-open", "merged", "closed"]);
export const STAGES = Object.freeze([...WORKING, ...RESTING]);
export const DECISIONS = Object.freeze([null, "APPROVE", "ESCALATE", "APPROVE (human)"]);
export const CHIPS = Object.freeze(["pending", "PASS", "CHANGES"]);
export const PKG_STATUSES = Object.freeze(["pending", "building", "done"]);
export const PROSE_MAX = 4000;

const STATE_KEYS = [
  "schema", "id", "repo", "title", "feature", "issue", "target", "branch", "linked", "worktree", "base",
  "head", "stage", "signoff", "packages", "lenses", "round", "rounds", "rework", "feedback", "decision",
  "pr", "note", "created", "updated"
];
const PACKAGE_KEYS = ["id", "title", "agent", "gap", "status"];

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const matches = (re) => (v) => typeof v === "string" && re.test(v);
export const nullable = (pred) => (v) => v === null || pred(v);
export const isInt = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
export const isProse = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= PROSE_MAX;
export const oneOf = (list) => (v) => list.includes(v);

export const hasExactKeys = (obj, keys) =>
  isObject(obj) &&
  Object.keys(obj).length === keys.length &&
  keys.every((k) => Object.hasOwn(obj, k));

export const isUnique = (list) => new Set(list).size === list.length;

export const isTarget = (v) =>
  matches(PATTERNS.target)(v) && !v.includes("..") && !v.startsWith("-");

export const issueInId = (id) => {
  const m = /^[0-9]{3}-i([0-9]+)-/.exec(id);
  return m ? m[1] : null;
};

const ascendingIds = (ids) => ids.every((id, i) => i === 0 || Number(id.slice(1)) > Number(ids[i - 1].slice(1)));

const isPackage = (p) =>
  hasExactKeys(p, PACKAGE_KEYS) &&
  matches(PATTERNS.pkgId)(p.id) &&
  matches(PATTERNS.title)(p.title) &&
  matches(PATTERNS.agent)(p.agent) &&
  nullable(matches(PATTERNS.gap))(p.gap) &&
  PKG_STATUSES.includes(p.status);

const isPackages = (v) =>
  Array.isArray(v) && v.length <= 9 && v.every(isPackage) && isUnique(v.map((p) => p.id)) &&
  ascendingIds(v.map((p) => p.id));

export const isLenses = (v) =>
  Array.isArray(v) && v.length > 0 && v.every(matches(PATTERNS.lens)) && isUnique(v) && v.includes("code");

const isRound = (lenses) => (r) =>
  isObject(r) &&
  Object.keys(r).length > 0 &&
  Object.hasOwn(r, "code") &&
  Object.keys(r).every((k) => lenses.includes(k) && CHIPS.includes(r[k]));

const issueMatchesId = (s) => {
  const fromId = issueInId(s.id);
  return fromId === null ? s.issue === null : String(s.issue) === fromId;
};

// Each rule: [field, predicate(value, state, ctx)]. Order matters: identity fields first.
const RULES = [
  ["schema", (v) => v === 1],
  ["id", (v, s, ctx) => matches(PATTERNS.id)(v) && (ctx.id === undefined || v === ctx.id)],
  ["repo", (v, s, ctx) => matches(PATTERNS.repo)(v) && (ctx.repo === undefined || v === ctx.repo)],
  ["title", matches(PATTERNS.title)],
  ["feature", isProse],
  ["issue", (v, s) => nullable(isInt(1, 1e9))(v) && issueMatchesId(s)],
  ["target", isTarget],
  ["branch", (v, s) => v === null || v === `factory/${s.id}`],
  ["linked", (v) => v === null || typeof v === "boolean"],
  ["worktree", (v, s, ctx) => v === null || v === worktreeDir(ctx.home, s.repo, s.id)],
  ["base", nullable(matches(PATTERNS.sha))],
  ["head", nullable(matches(PATTERNS.sha))],
  ["stage", oneOf(STAGES)],
  ["signoff", nullable(matches(PATTERNS.sha256))],
  ["packages", isPackages],
  ["lenses", isLenses],
  ["rounds", (v, s) => Array.isArray(v) && isLenses(s.lenses) && v.every(isRound(s.lenses))],
  ["round", (v, s) => Array.isArray(s.rounds) && v === s.rounds.length],
  ["rework", isInt(0, 10)],
  ["feedback", (v) => Array.isArray(v) && v.every(isProse)],
  ["decision", oneOf(DECISIONS)],
  ["pr", nullable(matches(PATTERNS.pr))],
  ["note", matches(PATTERNS.note)],
  ["created", matches(PATTERNS.stamp)],
  ["updated", matches(PATTERNS.stamp)]
];

// Returns the first invalid field name, or null when the state is valid.
// ctx: { home, id?, repo? } — id/repo pin the state to the folder it was read from.
export function invalidField(state, ctx) {
  if (!isObject(state)) return "state";
  const extra = Object.keys(state).find((k) => !STATE_KEYS.includes(k));
  if (extra !== undefined) return `unknown key ${extra.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`;
  const missing = STATE_KEYS.find((k) => !Object.hasOwn(state, k));
  if (missing !== undefined) return missing;
  const failed = RULES.find(([field, pred]) => !pred(state[field], state, ctx));
  return failed ? failed[0] : null;
}

export function assertValid(state, ctx) {
  const field = invalidField(state, ctx);
  if (field !== null) throw new Fail(2, `invalid ${field}`);
  return state;
}

export function check(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Fail(2, `invalid ${field}`);
  return value;
}
