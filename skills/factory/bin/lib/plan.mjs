// The `## Plan` block in spec.md: work packages, their builders, file ownership, and lenses.
import { Fail } from "./errors.mjs";
import { isGlob, isRepoPath, matchAny } from "./glob.mjs";
import { PATTERNS, hasExactKeys, isLenses, isUnique, matches } from "./validate.mjs";

const PLAN_KEYS = ["packages", "lenses"];
const PKG_KEYS = ["id", "title", "tags", "agent", "gap", "owns", "depends", "hotspots"];
const bad = (field) => new Fail(2, `invalid plan: ${field}`);

// The text inside the single ```json fence that directly follows `## Plan`.
export function extractPlanBlock(specText) {
  const lines = specText.split(/\r?\n/);
  const heads = lines.flatMap((l, i) => (/^## Plan\s*$/.test(l) ? [i] : []));
  if (heads.length === 0) throw bad("no ## Plan section");
  if (heads.length > 1) throw bad("more than one ## Plan section");
  const rest = lines.slice(heads[0] + 1);
  const next = rest.findIndex((l) => /^#{1,2} /.test(l));
  const section = next < 0 ? rest : rest.slice(0, next);
  if (section.filter((l) => /^```json\s*$/.test(l)).length !== 1) throw bad("expected exactly one json block");
  const first = section.findIndex((l) => l.trim() !== "");
  if (!/^```json\s*$/.test(section[first])) throw bad("json block must directly follow ## Plan");
  const close = section.findIndex((l, i) => i > first && /^```\s*$/.test(l));
  if (close < 0) throw bad("unterminated json block");
  return section.slice(first + 1, close).join("\n");
}

const listOf = (v, min, max, pred) =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(pred) && isUnique(v);

const pkgRules = (earlier) => [
  ["id", (p) => matches(PATTERNS.pkgId)(p.id)],
  ["title", (p) => matches(PATTERNS.title)(p.title)],
  ["tags", (p) => listOf(p.tags, 1, 6, matches(PATTERNS.tag))],
  ["agent", (p) => matches(PATTERNS.agent)(p.agent)],
  ["gap", (p) => (p.agent === "factory-builder" ? matches(PATTERNS.gap)(p.gap) : p.gap === null)],
  ["owns", (p) => listOf(p.owns, 1, 20, isGlob)],
  ["depends", (p) => listOf(p.depends, 0, 8, (d) => earlier.includes(d))],
  ["hotspots", (p) => listOf(p.hotspots, 0, 10, (h) => isRepoPath(h))]
];

function checkPackage(p, i, all) {
  if (!hasExactKeys(p, PKG_KEYS)) throw bad(`package ${i + 1} keys`);
  const earlier = all.slice(0, i).map((q) => q.id);
  const failed = pkgRules(earlier).find(([, pred]) => !pred(p));
  if (failed) throw bad(`${matches(PATTERNS.pkgId)(p.id) ? p.id : `package ${i + 1}`}.${failed[0]}`);
  if (i > 0 && Number(p.id.slice(1)) <= Number(all[i - 1].id.slice(1))) throw bad(`${p.id}.id order`);
}

// Shape-only validation; returns the parsed plan.
export function parsePlan(specText) {
  let plan;
  try {
    plan = JSON.parse(extractPlanBlock(specText));
  } catch (err) {
    throw err instanceof Fail ? err : bad("json");
  }
  if (!hasExactKeys(plan, PLAN_KEYS)) throw bad("keys");
  if (!Array.isArray(plan.packages) || plan.packages.length < 1 || plan.packages.length > 9) throw bad("packages");
  plan.packages.forEach(checkPackage);
  if (!isLenses(plan.lenses)) throw bad("lenses");
  return plan;
}

// First file owned by two packages, as [file, idA, idB], or null.
export function findOverlap(packages, files) {
  for (const file of files) {
    const owners = packages.filter((p) => matchAny(p.owns, file)).map((p) => p.id);
    if (owners.length > 1) return [file, owners[0], owners[1]];
  }
  return null;
}

// Full validation against the roster and the repo's files; returns state-ready fields.
export function validatePlan(plan, roster, files) {
  const builders = new Set(roster.builders.map((b) => b.name));
  const lenses = new Set(roster.reviewers.map((r) => r.lens));
  const unknownAgent = plan.packages.find((p) => !builders.has(p.agent));
  if (unknownAgent) throw bad(`${unknownAgent.id}.agent not in roster`);
  const unknownLens = plan.lenses.find((l) => !lenses.has(l));
  if (unknownLens) throw bad(`lens ${unknownLens} has no reviewer in roster`);
  const overlap = findOverlap(plan.packages, files);
  if (overlap) throw bad(`${overlap[1]} and ${overlap[2]} both own ${overlap[0].slice(0, 80)}`);
  return {
    packages: plan.packages.map((p) => ({ id: p.id, title: p.title, agent: p.agent, gap: p.gap, status: "pending" })),
    lenses: [...plan.lenses]
  };
}

// Files a package touched that it neither owns nor lists as a hotspot.
export const outOfScope = (pkg, files) => files.filter((f) => !matchAny(pkg.owns, f) && !pkg.hotspots.includes(f));
