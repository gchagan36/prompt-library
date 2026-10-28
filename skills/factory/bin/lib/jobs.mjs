// Opening jobs, the guarded mutation path every state write goes through, and listing.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { Fail } from "./errors.mjs";
import { factoryHome, jobDir, jobsDir, now, reposDir } from "./paths.mjs";
import { checkToken, leaseStatus, readLease } from "./lease.mjs";
import { parseJson, readStateText, writeState } from "./store.mjs";
import { PATTERNS, WORKING, assertValid, check, invalidField } from "./validate.mjs";

const isDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function parseJobRef(ref) {
  if (typeof ref !== "string") throw new Fail(2, "invalid job");
  const slash = ref.indexOf("/");
  if (slash < 0) throw new Fail(2, "invalid job: expected <repo>/<id>");
  return { repo: check(ref.slice(0, slash), PATTERNS.repo, "repo"), id: check(ref.slice(slash + 1), PATTERNS.id, "id") };
}

export function openJob(ctx, ref) {
  const home = factoryHome(ctx.env);
  const { repo, id } = parseJobRef(ref);
  const dir = jobDir(home, repo, id);
  if (!isDir(dir)) throw new Fail(5, `no job ${repo}/${id}`);
  return { home, repo, id, dir, ref: `${repo}/${id}` };
}

export const validationCtx = (job) => ({ home: job.home, repo: job.repo, id: job.id });

// Splits the trailing `--lease <token> --expect <hash>` off a mutating command's args.
export function splitAuth(args) {
  const n = args.length;
  if (n < 4 || args[n - 4] !== "--lease" || args[n - 2] !== "--expect") {
    throw new Fail(2, "mutating commands end with --lease <token> --expect <hash>");
  }
  return {
    rest: args.slice(0, n - 4),
    token: check(args[n - 3], PATTERNS.token, "token"),
    expect: check(args[n - 1], PATTERNS.sha256, "expect")
  };
}

// Lease check, then hash check, then the pure update, then validation, then the write.
// `update(state, job)` returns the next state; it must not mutate its input.
export function mutate(ctx, ref, auth, update) {
  const job = openJob(ctx, ref);
  checkToken(readLease(job.dir), auth.token);
  const { text, hash } = readStateText(job.dir);
  if (hash !== auth.expect) throw new Fail(3, "state.json changed outside factoryctl");
  const state = parseJson(text, "state");
  const next = assertValid({ ...update(state, job), updated: now() }, validationCtx(job));
  ctx.out(writeState(job.dir, next));
  return next;
}

// Like mutate, but for commands that may leave the state unchanged: writes only on change
// and prints the (possibly unchanged) hash.
export function mutateIfChanged(ctx, ref, auth, update) {
  const job = openJob(ctx, ref);
  checkToken(readLease(job.dir), auth.token);
  const { text, hash } = readStateText(job.dir);
  if (hash !== auth.expect) throw new Fail(3, "state.json changed outside factoryctl");
  const state = parseJson(text, "state");
  const next = update(state, job);
  if (next === state) {
    ctx.out(hash);
    return state;
  }
  const valid = assertValid({ ...next, updated: now() }, validationCtx(job));
  ctx.out(writeState(job.dir, valid));
  return valid;
}

export const repoKeys = (home) =>
  existsSync(reposDir(home)) ? readdirSync(reposDir(home)).filter((k) => PATTERNS.repo.test(k)).sort() : [];

export const jobIds = (home, repo) =>
  isDir(jobsDir(home, repo)) ? readdirSync(jobsDir(home, repo)).filter((d) => !d.startsWith(".")).sort() : [];

// One summary per job folder. Unreadable or invalid jobs are listed, flagged `invalid`.
export function summarize(env, home, repo, id) {
  const dir = jobDir(home, repo, id);
  let lease = "free";
  try {
    lease = leaseStatus(readLease(dir), env);
  } catch {
    lease = "free";
  }
  try {
    const state = parseJson(readStateText(dir).text, "state");
    const field = invalidField(state, { home, repo, id });
    if (field !== null) return { repo, id, invalid: `invalid ${field}`, lease, orphan: false, state: null };
    return { repo, id, lease, orphan: WORKING.includes(state.stage) && lease !== "live", state };
  } catch (err) {
    return { repo, id, invalid: err.message, lease, orphan: false, state: null };
  }
}

export const allJobs = (env, home, onlyRepo) =>
  (onlyRepo ? [onlyRepo] : repoKeys(home)).flatMap((repo) => jobIds(home, repo).map((id) => summarize(env, home, repo, id)));
