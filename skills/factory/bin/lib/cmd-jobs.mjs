// Job lifecycle commands: repo, create, claim, release, hash, show, validate, list, restore.
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { Fail } from "./errors.mjs";
import { git } from "./git.mjs";
import { checkToken, findOwner, leaseStatus, newLease, readLease, withClaimLock, writeLease } from "./lease.mjs";
import { factoryHome, jobDir, jobsDir, now, repoFile, seqDir } from "./paths.mjs";
import { atomicWrite, parseJson, readGuarded, readStateText, restoreState, serialize, sha256, writeState } from "./store.mjs";
import { allJobs, openJob, splitAuth, validationCtx } from "./jobs.mjs";
import {
  PATTERNS, RESTING, assertValid, check, hasExactKeys, isInt, isProse, isTarget, matches, nullable
} from "./validate.mjs";

const CREATE_KEYS = ["slug", "issue", "title", "feature", "target"];
const MAX_SEQ = 999;

const expectArgs = (args, n, form) => {
  if (args.length !== n) throw new Fail(2, `usage: ${form}`);
  return args;
};

const stripCredentials = (url) => url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, "$1");

export function cmdRepo(ctx, args) {
  expectArgs(args, 0, "repo");
  const common = realpathSync(path.resolve(ctx.cwd, git(ctx.cwd, ["rev-parse", "--git-common-dir"])));
  const main = path.basename(common) === ".git" ? path.dirname(common) : common;
  const name = path.basename(main).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  const key = check(`${name}-${sha256(common).slice(0, 8)}`, PATTERNS.repo, "repo key");
  let remote = null;
  try {
    remote = stripCredentials(git(main, ["remote", "get-url", "origin"]));
  } catch {
    remote = null;
  }
  const home = factoryHome(ctx.env);
  mkdirSync(jobsDir(home, key), { recursive: true });
  atomicWrite(repoFile(home, key), serialize({ key, name, path: main, remote, updated: now() }));
  ctx.out(key);
}

const readInputJson = (file, what) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Fail(2, `cannot read ${what} file`);
  }
  return parseJson(text, what);
};

const pad = (n) => String(n).padStart(3, "0");

const highestSeq = (names) =>
  names.map((n) => /^([0-9]{3})(-|$)/.exec(n)).filter(Boolean).reduce((max, m) => Math.max(max, Number(m[1])), 0);

// Reserves the next job number with an exclusive mkdir under seq/, so concurrent creates
// in different sessions never share a number even when their slugs differ.
function allocate(home, repo, min) {
  mkdirSync(seqDir(home, repo), { recursive: true });
  mkdirSync(jobsDir(home, repo), { recursive: true });
  const seen = [...readdirSync(seqDir(home, repo)), ...readdirSync(jobsDir(home, repo))];
  for (let n = Math.max(highestSeq(seen) + 1, min, 1); n <= MAX_SEQ; n += 1) {
    try {
      mkdirSync(path.join(seqDir(home, repo), pad(n)));
      return n;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Fail(2, "job numbers exhausted");
}

const parseMin = (opts) => {
  if (opts.length === 0) return 1;
  if (opts.length !== 2 || opts[0] !== "--min" || !/^[0-9]{1,3}$/.test(opts[1])) throw new Fail(2, "invalid --min");
  return Number(opts[1]);
};

const initialState = (repo, id, input) => ({
  schema: 1, id, repo, title: input.title, feature: input.feature, issue: input.issue, target: input.target,
  branch: null, linked: null, worktree: null, base: null, head: null, stage: "spec", signoff: null,
  packages: [], lenses: ["code"], round: 0, rounds: [], rework: 0, feedback: [], decision: null, pr: null,
  note: "writing spec", created: now(), updated: now()
});

const idFor = (n, input) => `${pad(n)}${input.issue === null ? "" : `-i${input.issue}`}-${input.slug}`;

function checkCreateInput(input) {
  if (!hasExactKeys(input, CREATE_KEYS)) throw new Fail(2, "invalid job file: keys");
  const rules = [
    ["slug", matches(PATTERNS.slug)],
    ["issue", nullable(isInt(1, 1e9))],
    ["title", matches(PATTERNS.title)],
    ["feature", isProse],
    ["target", isTarget]
  ];
  const bad = rules.find(([k, pred]) => !pred(input[k]));
  if (bad) throw new Fail(2, `invalid ${bad[0]}`);
  return input;
}

export function cmdCreate(ctx, args) {
  if (args.length < 2) throw new Fail(2, "usage: create <repo> <file> [--min N]");
  const [repo, file, ...opts] = args;
  check(repo, PATTERNS.repo, "repo");
  const min = parseMin(opts);
  const home = factoryHome(ctx.env);
  readGuarded(repoFile(home, repo));
  const input = checkCreateInput(readInputJson(file, "job"));
  assertValid(initialState(repo, idFor(0, input), input), { home });
  const id = idFor(allocate(home, repo, min), input);
  const dir = jobDir(home, repo, id);
  mkdirSync(dir);
  const { token, lease } = newLease(ctx.env);
  writeLease(dir, lease);
  const hash = writeState(dir, assertValid(initialState(repo, id, input), { home, repo, id }));
  [id, token, hash].forEach((line) => ctx.out(line));
}

export function cmdClaim(ctx, args) {
  // No same-session reclaim: subagents run inside the orchestrator's claude process, so
  // "same owner process" can't tell them apart. Only a free lease can be claimed.
  if (args.length !== 1) throw new Fail(2, "usage: claim <job>");
  const job = openJob(ctx, args[0]);
  withClaimLock(job.dir, () => {
    const current = readLease(job.dir);
    const status = leaseStatus(current, ctx.env);
    const owner = findOwner(ctx.env);
    if (status === "live") {
      throw new Fail(6, `lease held by live session pid ${current.pid} since ${current.claimed}`);
    }
    const { text, hash } = readStateText(job.dir);
    assertValid(parseJson(text, "state"), validationCtx(job));
    const { token, lease } = newLease(ctx.env, owner);
    writeLease(job.dir, lease);
    ctx.out(token);
    ctx.out(hash);
  });
}

export function cmdRelease(ctx, args) {
  const auth = splitAuth(args);
  const [ref] = expectArgs(auth.rest, 1, "release <job> --lease <token> --expect <hash>");
  const job = openJob(ctx, ref);
  const lease = readLease(job.dir);
  checkToken(lease, auth.token);
  const { text, hash } = readStateText(job.dir);
  if (hash !== auth.expect) throw new Fail(3, "state.json changed outside factoryctl");
  const state = parseJson(text, "state");
  if (!RESTING.includes(state.stage)) throw new Fail(2, "release only at a resting stage");
  writeLease(job.dir, { ...lease, released: now() });
  ctx.out(hash);
}

export function cmdRestore(ctx, args) {
  if (args.length !== 4 || args[2] !== "--lease") throw new Fail(2, "usage: restore <job> <hash> --lease <token>");
  const job = openJob(ctx, args[0]);
  const hash = check(args[1], PATTERNS.sha256, "hash");
  checkToken(readLease(job.dir), check(args[3], PATTERNS.token, "token"));
  ctx.out(restoreState(job.dir, hash));
}

export function cmdHash(ctx, args) {
  const job = openJob(ctx, expectArgs(args, 1, "hash <job>")[0]);
  ctx.out(readStateText(job.dir).hash);
}

export function cmdShow(ctx, args) {
  const job = openJob(ctx, expectArgs(args, 1, "show <job>")[0]);
  ctx.out(readStateText(job.dir).text.trimEnd());
}

export function cmdValidate(ctx, args) {
  if (args.length > 1) throw new Fail(2, "usage: validate [<repo>]");
  const repo = args.length === 1 ? check(args[0], PATTERNS.repo, "repo") : undefined;
  const bad = allJobs(ctx.env, factoryHome(ctx.env), repo).find((j) => j.invalid);
  if (bad) throw new Fail(2, `${bad.repo}/${bad.id}: ${bad.invalid}`);
  ctx.out("ok");
}

export function cmdList(ctx, args) {
  const ok = args.length === 0 || (args.length === 2 && args[0] === "--repo");
  if (!ok) throw new Fail(2, "usage: list [--repo <repo>]");
  const repo = args.length === 2 ? check(args[1], PATTERNS.repo, "repo") : undefined;
  const rows = allJobs(ctx.env, factoryHome(ctx.env), repo).map((j) =>
    j.state
      ? { repo: j.repo, id: j.id, title: j.state.title, stage: j.state.stage, lease: j.lease, orphan: j.orphan, note: j.state.note, updated: j.state.updated }
      : { repo: j.repo, id: j.id, title: null, stage: null, lease: j.lease, orphan: false, note: null, updated: null, invalid: j.invalid }
  );
  ctx.out(JSON.stringify(rows, null, 2));
}
