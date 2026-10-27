// Shared test scaffolding: a temp FACTORY_HOME, temp git repos, and an in-process factoryctl.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../bin/lib/cli.mjs";
import { psInfo } from "../bin/lib/lease.mjs";

export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");
export const DASHBOARD_DIR = path.join(BIN, "..", "dashboard");

export const tempDir = (prefix = "factory-test-") => mkdtempSync(path.join(tmpdir(), prefix));

// The test runner process stands in for the `claude` session that owns leases. Node 24
// renames its main thread, so the runner's comm is read from ps rather than assumed.
export const OWNER_COMM = psInfo(process.ppid).comm;
export const makeEnv = (home, extra = {}) => ({ ...process.env, FACTORY_HOME: home, FACTORY_OWNER_COMM: OWNER_COMM, ...extra });

// Runs factoryctl in-process. Returns { code, out: [lines], err: string }.
export function ctl(env, args, cwd = process.cwd()) {
  const out = [];
  const err = [];
  const code = run(args, { env, cwd, out: (l) => out.push(...String(l).split("\n")), err: (l) => err.push(l) });
  return { code, out, err: err.join("\n") };
}

// Runs the real binary as a child process (for concurrency tests).
export function spawnCtl(env, args, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BIN, "factoryctl.mjs"), ...args], { env, cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim().split("\n"), err }));
  });
}

export const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A git repo with one commit of the given files.
export function makeRepo(files = { "README.md": "# demo\n" }, name = "demo-repo") {
  const root = path.join(tempDir("factory-repo-"), name);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFiles(root, files);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

export function writeFiles(root, files) {
  Object.entries(files).forEach(([rel, content]) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  });
}

export function commitFiles(cwd, files, message = "change") {
  writeFiles(cwd, files);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

export const jobInput = (overrides = {}) => ({
  slug: "demo-job",
  issue: null,
  title: "Demo Job",
  feature: "Build the demo feature",
  target: "main",
  ...overrides
});

// A fresh home + registered repo + one job. Returns everything a test needs to mutate it.
export function setup(opts = {}) {
  const home = tempDir();
  const env = makeEnv(home, opts.env || {});
  const repoPath = opts.repoPath || makeRepo(opts.files);
  const repo = ctl(env, ["repo"], repoPath).out[0];
  const file = writeJson(tempDir(), "job.json", jobInput(opts.input));
  const created = ctl(env, ["create", repo, file]);
  if (created.code !== 0) throw new Error(`create failed: ${created.err}`);
  const [id, token, hash] = created.out;
  const job = `${repo}/${id}`;
  const dir = path.join(home, "repos", repo, "jobs", id);
  const session = { home, env, repo, repoPath, id, job, dir, token, hash };
  // Runs a mutating command with the current lease and hash, tracking the new hash.
  session.mut = (args) => {
    const res = ctl(env, [...args, "--lease", session.token, "--expect", session.hash]);
    if (res.code === 0) session.hash = res.out.at(-1);
    return res;
  };
  return session;
}
