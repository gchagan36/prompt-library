// Routing commands: roster, plan, ownership, lenses, plus the gap ledger and the secret scan.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { discoverRoster } from "./agents.mjs";
import { Fail } from "./errors.mjs";
import { appendGap, groupGaps, readGaps } from "./gaps.mjs";
import { renderScan, scanDiff } from "./comments.mjs";
import { diffNames, gitLines, gitRaw } from "./git.mjs";
import { mutate, mutateIfChanged, openJob, splitAuth } from "./jobs.mjs";
import { ROSTER, factoryHome, repoFile } from "./paths.mjs";
import { outOfScope, parsePlan, validatePlan } from "./plan.mjs";
import { lensChanges, triggeredLenses } from "./routing.mjs";
import { scanFiles } from "./secrets.mjs";
import { atomicWrite, parseJson, readGuarded, readStateText, serialize, sha256 } from "./store.mjs";
import { resolveJobFile } from "./jobfiles.mjs";
import { specHash } from "./cmd-state.mjs";
import { PATTERNS, check } from "./validate.mjs";

const isDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function cmdRoster(ctx, args) {
  if (args.length !== 2) throw new Fail(2, "usage: roster <job> <repo-path>");
  const job = openJob(ctx, args[0]);
  const repoPath = path.resolve(ctx.cwd, args[1]);
  if (!isDir(repoPath)) throw new Fail(2, "invalid repo path");
  const text = serialize(discoverRoster(ctx.env, repoPath));
  atomicWrite(path.join(job.dir, ROSTER), text);
  ctx.out(sha256(text));
}

const readRoster = (dir) => {
  const roster = parseJson(readGuarded(path.join(dir, ROSTER)), "roster");
  if (!roster || !Array.isArray(roster.builders) || !Array.isArray(roster.reviewers)) {
    throw new Fail(2, "invalid roster");
  }
  return roster;
};

const readSpec = (dir) => {
  const file = resolveJobFile(dir, "spec.md");
  if (file === null) throw new Fail(5, "missing spec.md");
  return readFileSync(file, "utf8");
};

const worktreeOf = (state) => (state.worktree && isDir(state.worktree) ? state.worktree : null);

// Files the overlap check runs against: the worktree's tracked files and the job's diff,
// or the main checkout's tracked files before a worktree exists.
function overlapFiles(job, state) {
  const wt = worktreeOf(state);
  if (wt) {
    const diff = state.base && state.head ? diffNames(wt, state.base, state.head) : [];
    return [...new Set([...gitLines(wt, ["ls-files"]), ...diff])];
  }
  const info = parseJson(readGuarded(repoFile(job.home, job.repo)), "repo");
  return typeof info.path === "string" && isDir(info.path) ? gitLines(info.path, ["ls-files"]) : [];
}

export function cmdPlan(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 1) throw new Fail(2, "usage: plan <job> --lease <token> --expect <hash>");
  mutate(ctx, auth.rest[0], auth, (state, job) => {
    if (state.stage !== "spec" && state.stage !== "signoff") throw new Fail(2, "plan only in stage spec or signoff");
    const plan = parsePlan(readSpec(job.dir));
    const fields = validatePlan(plan, readRoster(job.dir), overlapFiles(job, state));
    // Lenses never shrink once a round has used them (rounds' chips must stay valid).
    const lenses = state.rounds.length > 0 ? [...new Set([...state.lenses, ...fields.lenses])] : fields.lenses;
    return { ...state, ...fields, lenses };
  });
}

const readState = (dir) => parseJson(readStateText(dir).text, "state");

export function cmdOwnership(ctx, allArgs) {
  const unowned = allArgs.at(-1) === "--unowned";
  const args = unowned ? allArgs.slice(0, -1) : allArgs;
  if (args.length !== 4) throw new Fail(2, "usage: ownership <job> <P> <from-sha> <to-sha> [--unowned]");
  const job = openJob(ctx, args[0]);
  const pkgId = check(args[1], PATTERNS.pkgId, "package");
  const [from, to] = [check(args[2], PATTERNS.sha, "from"), check(args[3], PATTERNS.sha, "to")];
  const state = readState(job.dir);
  if (state.signoff === null) throw new Fail(2, "spec not signed off");
  if (specHash(job.dir) !== state.signoff) throw new Fail(3, "spec.md changed after sign-off");
  const { packages } = parsePlan(readSpec(job.dir));
  const pkg = packages.find((p) => p.id === pkgId);
  if (!pkg) throw new Fail(2, `no package ${pkgId}`);
  const wt = worktreeOf(state);
  if (!wt) throw new Fail(5, "no worktree");
  const stray = outOfScope(pkg, diffNames(wt, from, to), unowned ? packages : null);
  stray.forEach((f) => ctx.out(f));
  if (stray.length > 0) throw new Fail(1, `${stray.length} file(s) outside package ${pkgId}`);
}

export function cmdLenses(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 1) throw new Fail(2, "usage: lenses <job> --lease <token> --expect <hash>");
  mutateIfChanged(ctx, auth.rest[0], auth, (state, job) => {
    const wt = worktreeOf(state);
    if (!wt || !state.base || !state.head) throw new Fail(2, "lenses needs worktree, base and head");
    const reviewers = readRoster(job.dir).reviewers;
    const triggered = triggeredLenses(diffNames(wt, state.base, state.head), reviewers);
    const { added, missing } = lensChanges(state.lenses, triggered, reviewers);
    added.forEach((l) => ctx.out(`added ${l}`));
    missing.forEach((l) => ctx.out(`missing ${l}`));
    return added.length > 0 ? { ...state, lenses: [...state.lenses, ...added] } : state;
  });
}

// Writes round-<r>/comments-scan.md for the docs reviewer; prints the candidate count.
export function cmdComments(ctx, args) {
  if (args.length !== 2) throw new Fail(2, "usage: comments <job> <round>");
  const job = openJob(ctx, args[0]);
  if (!/^[1-9][0-9]?$/.test(args[1])) throw new Fail(2, "invalid round");
  const round = Number(args[1]);
  const state = readState(job.dir);
  if (round > state.round) throw new Fail(2, `no round ${round}`);
  const wt = worktreeOf(state);
  if (!wt || !state.base || !state.head) throw new Fail(2, "comments needs worktree, base and head");
  const roundDir = path.join(job.dir, `round-${round}`);
  if (!isDir(roundDir)) throw new Fail(5, `no round-${round} folder`);
  const diff = gitRaw(wt, ["diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", `${state.base}..${state.head}`]);
  const scan = scanDiff(diff);
  atomicWrite(path.join(roundDir, "comments-scan.md"), renderScan(scan, { round, base: state.base, head: state.head }));
  ctx.out(String(scan.candidates.length));
}

export function cmdGap(ctx, args) {
  if (args.length !== 2) throw new Fail(2, "usage: gap <job> <file>");
  const job = openJob(ctx, args[0]);
  if (!existsSync(args[1])) throw new Fail(2, "cannot read gap file");
  appendGap(job.home, job.repo, job.id, parseJson(readFileSync(args[1], "utf8"), "gap"));
  ctx.out("ok");
}

export function cmdGaps(ctx, args) {
  if (args.length !== 0) throw new Fail(2, "usage: gaps");
  ctx.out(JSON.stringify(groupGaps(readGaps(factoryHome(ctx.env))), null, 2));
}

export function cmdScan(ctx, args) {
  const hits = scanFiles(args);
  hits.forEach((h) => ctx.out(h));
  return hits.length > 0 ? 1 : 0;
}
