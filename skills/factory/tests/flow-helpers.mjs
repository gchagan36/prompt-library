// An orchestrator stand-in for the end-to-end flow tests: it runs the commands SKILL.md
// and references/github.md prescribe, in their order, with canned files in place of
// agents and a bare git repo in place of GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitFiles, ctl, git, makeEnv, makeRepo, tempDir } from "./helpers.mjs";

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../agents");
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
const sha = (file) => sh(`sha256sum '${file}'`).stdout.split(" ")[0];

// A repo <R> with a bare origin, a FACTORY_HOME, and a session scratch dir <tmp>.
export function newFactory(files) {
  const originDir = tempDir("factory-origin-");
  const origin = path.join(originDir, "origin.git");
  git(originDir, ["init", "-q", "--bare", "-b", "main", origin]);
  const R = makeRepo(files);
  git(R, ["remote", "add", "origin", origin]);
  git(R, ["push", "-q", "origin", "main"]);
  const home = tempDir("factory-home-");
  return { R, origin, home, tmp: tempDir("factory-tmp-"), env: makeEnv(home, { FACTORY_AGENT_DIRS: AGENTS_DIR }) };
}

export const specWith = (plan, extra = "") =>
  `# Spec\n## Summary\nA demo change.\n## Acceptance criteria\n- AC-1: works\n## Plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n## Docs impact\nNone\n${extra}`;

// Paths that differ between two listings written by the SKILL.md snapshot command.
function diffPaths(a, b) {
  const out = sh(`diff '${a}' '${b}'`).stdout;
  const paths = out.split("\n").filter((l) => /^[<>] /.test(l)).map((l) => l.split(/\s+/).at(-1).replace(/^\.\//, ""));
  return [...new Set(paths)].sort();
}

export function orchestrator(f) {
  const o = { f, keys: null, job: null, id: null, J: null, W: null, kept: null, lastAfter: null, pins: {} };
  o.fctl = (args) => ctl(f.env, args, f.R);
  // A write with the held lease and hash; the new hash replaces the held one.
  o.w = (args) => {
    const res = o.fctl([...args, "--lease", o.keys.token, "--expect", o.keys.hash]);
    if (res.code === 0) o.keys = { ...o.keys, hash: res.out.filter(Boolean).at(-1) };
    return res;
  };
  o.must = (args) => {
    const res = o.w(args);
    assert.equal(res.code, 0, `${args.join(" ")}: ${res.err}`);
    return res;
  };
  o.state = () => JSON.parse(readFileSync(path.join(o.J, "state.json"), "utf8"));
  o.claim = () => {
    const res = o.fctl(["claim", o.job]);
    if (res.code === 0) o.keys = { token: res.out[0], hash: res.out[1] };
    return res;
  };

  // /factory <feature> step 3: one more than the highest remote factory/NNN as --min.
  o.create = (input) => {
    const heads = git(f.R, ["ls-remote", "--heads", "origin", "refs/heads/factory/*"]);
    const nums = [...heads.matchAll(/refs\/heads\/factory\/([0-9]{3})-/g)].map((m) => Number(m[1]));
    const min = String(nums.length ? Math.max(...nums) + 1 : 1);
    const repo = o.fctl(["repo"]).out[0];
    const file = path.join(f.tmp, "job.json");
    writeFileSync(file, JSON.stringify({ issue: null, target: "main", ...input }));
    const res = o.fctl(["create", repo, file, "--min", min]);
    assert.equal(res.code, 0, res.err);
    const [id, token, hash] = res.out;
    Object.assign(o, { id, job: `${repo}/${id}`, keys: { token, hash }, min: Number(min) });
    o.J = path.join(f.home, "repos", repo, "jobs", id);
    o.W = path.join(f.home, "repos", repo, "worktrees", id);
    return id;
  };

  // Integrity: job folder. Returns changes made between agents (continuity) that are
  // not the orchestrator's own.
  const listing = (file) =>
    sh(`( cd '${o.J}' && find . -type f ! -name state.json ! -name state.prev.json ! -name lease.json -print0 | sort -z | xargs -0 -r sha256sum ) > '${file}'`);
  o.snapshot = (own = []) => {
    const before = path.join(f.tmp, `${o.id}.before`);
    listing(before);
    o.kept = sha(before);
    const between = o.lastAfter ? diffPaths(o.lastAfter, before) : [];
    return between.filter((p) => !own.includes(p));
  };
  o.integrity = (allowed) => {
    const before = path.join(f.tmp, `${o.id}.before`);
    assert.equal(sha(before), o.kept, ".before listing was changed");
    const after = path.join(f.tmp, `${o.id}.after`);
    listing(after);
    o.lastAfter = path.join(f.tmp, `${o.id}.last`);
    sh(`cp '${after}' '${o.lastAfter}'`);
    return diffPaths(before, after).filter((p) => !allowed.includes(p));
  };
  o.head = () => git(o.W, ["rev-parse", "HEAD"]);

  // Sign-off: stage=signoff, then the human signs off.
  o.signOff = () => {
    o.must(["set", o.job, "stage=signoff"]);
    o.must(["signoff", o.job]);
  };

  // github.md Branch and worktree, without an issue.
  o.branch = () => {
    git(f.R, ["fetch", "-q", "origin", "main"]);
    const base = git(f.R, ["rev-parse", "origin/main"]);
    git(f.R, ["worktree", "add", "-q", "-b", `factory/${o.id}`, o.W, base]);
    o.must(["set", o.job, `branch=factory/${o.id}`, `worktree=${o.W}`, `base=${base}`, `head=${base}`]);
    o.prepareDeps();
    return base;
  };
  o.readdWorktree = () => {
    git(f.R, ["worktree", "add", "-q", o.W, `factory/${o.id}`]);
    o.must(["set", o.job, `worktree=${o.W}`]);
    o.prepareDeps();
  };
  // github.md Prepare deps, step 2 (no profile Setup line in these repos).
  o.prepareDeps = () => {
    if (!existsSync(path.join(f.R, "node_modules"))) return;
    const res = sh(`ln -sfn '${f.R}/node_modules' '${o.W}/node_modules' && EX="$(git rev-parse --git-common-dir)/info/exclude" && { grep -qx '/node_modules' "$EX" || echo '/node_modules' >> "$EX"; }`, o.W);
    assert.equal(res.status, 0, res.stderr);
  };

  // Build packages. work[P](o) commits in <W> and writes build-<P>.md; it may return a
  // second callback, the builder's reply to an ownership message. `ownFiles` lists files the
  // orchestrator itself created since the last agent (e.g. outside-<k>.md).
  o.buildPass = ({ work, unownedLast = false, ownFiles = [] }) => {
    const pkgs = o.state().packages;
    const results = {};
    pkgs.forEach((pkg, i) => {
      o.must(["pkg", o.job, pkg.id, "building"]);
      const from = o.state().head;
      assert.deepEqual(o.snapshot(i === 0 ? ownFiles : []), [], "nothing changed between agents");
      const reply = work[pkg.id](o);
      assert.deepEqual(o.integrity([`build-${pkg.id}.md`]), []);
      assert.ok(existsSync(path.join(o.J, `build-${pkg.id}.md`)), "build check: build file");
      assert.equal(git(o.W, ["status", "--porcelain"]), "", "build check: clean worktree");
      assert.notEqual(o.head(), from, "build check: branch moved");
      const flag = unownedLast && i === pkgs.length - 1 ? ["--unowned"] : [];
      let own = o.fctl(["ownership", o.job, pkg.id, from, o.head(), ...flag]);
      results[pkg.id] = { first: own };
      if (own.code === 1 && reply) {
        reply(o, own.out.filter(Boolean));
        own = o.fctl(["ownership", o.job, pkg.id, from, o.head(), ...flag]);
      }
      assert.equal(own.code, 0, `ownership ${pkg.id}: ${own.out.join(",")}`);
      o.must(["set", o.job, `head=${o.head()}`]);
      o.must(["pkg", o.job, pkg.id, "done"]);
    });
    return results;
  };

  // Review round. verdicts[lens] is the first line a reviewer writes (default PASS);
  // tamper(o, r) runs after every reviewer was pinned and chipped.
  o.reviewRound = ({ verdicts = {}, tamper } = {}) => {
    const lensOut = o.must(["lenses", o.job]).out.filter(Boolean).slice(0, -1);
    lensOut.filter((l) => l.startsWith("missing ")).forEach((l) => o.gap({ kind: "reviewer", specialty: l.slice(8), package: null, fallback: null, reason: "no reviewer" }));
    o.must(["round", o.job]);
    const r = o.state().round;
    mkdirSync(path.join(o.J, `round-${r}`));
    const lenses = Object.keys(o.state().rounds.at(-1));
    if (lenses.includes("docs")) assert.equal(o.fctl(["comments", o.job, String(r)]).code, 0);
    const own = [`round-${r}/comments-scan.md`];
    assert.deepEqual(o.snapshot(own), [], "nothing changed between agents");
    const mark = o.head();
    const pins = {};
    lenses.forEach((lens) => {
      const file = path.join(o.J, `round-${r}`, `review-${lens}.md`);
      writeFileSync(file, `${verdicts[lens] ?? "VERDICT: PASS"}\n\n## Findings\n- None\n`);
      pins[lens] = sha(file);
      o.must(["chip", o.job, lens, file]);
    });
    if (tamper) tamper(o, r);
    const stray = o.integrity(lenses.map((l) => `round-${r}/review-${l}.md`));
    const moved = o.head() !== mark;
    const changed = lenses.filter((l) => sha(path.join(o.J, `round-${r}`, `review-${l}.md`)) !== pins[l]);
    return { r, lenses, lensOut, chips: o.state().rounds.at(-1), stray, moved, changed };
  };

  o.gap = (g) => {
    const file = path.join(f.tmp, "gap.json");
    writeFileSync(file, JSON.stringify(g));
    assert.equal(o.fctl(["gap", o.job, file]).code, 0);
  };

  // Approve: stage, sign-off check, fresh decision.md, approver, decision from line 1.
  o.approve = (first = "APPROVE") => {
    o.must(["set", o.job, "stage=approve"]);
    assert.equal(o.fctl(["signoff-check", o.job]).code, 0);
    const decision = path.join(o.J, "decision.md");
    const deleted = existsSync(decision) ? ["decision.md"] : [];
    sh(`rm -f '${decision}'`);
    assert.deepEqual(o.snapshot(deleted), []);
    const mark = o.head();
    writeFileSync(decision, `${first}\nMatches the signed-off spec.\n`);
    assert.deepEqual(o.integrity(["decision.md"]), []);
    assert.equal(o.head(), mark, "branch moved during review");
    const verdict = readFileSync(decision, "utf8").split("\n")[0] === "APPROVE" ? "APPROVE" : "ESCALATE";
    return o.w(["set", o.job, `decision=${verdict}`]);
  };

  // github.md Ship, with a fake PR URL standing in for gh pr create.
  o.ship = (prUrl, note = "PR opened") => {
    assert.equal(o.head(), o.state().head, "head check");
    git(o.W, ["push", "-q", "origin", `${o.state().head}:refs/heads/factory/${o.id}`]);
    if (o.state().pr === null) o.must(["set", o.job, `pr=${prUrl}`]);
    git(f.R, ["worktree", "remove", o.W]);
    o.must(["set", o.job, "worktree=null"]);
    o.must(["set", o.job, "stage=pr-open"]);
    o.must(["note", o.job, "--text", note]);
    o.must(["release", o.job]);
  };

  // github.md Sync for a merged PR whose head is the job's head.
  o.syncMerged = (mergeSha) => {
    assert.equal(o.claim().code, 0);
    const headRefOid = git(f.R, ["ls-remote", "origin", `refs/heads/factory/${o.id}`]).split(/\s+/)[0];
    assert.equal(git(f.R, ["rev-parse", `factory/${o.id}`]), headRefOid);
    git(f.R, ["branch", "-D", `factory/${o.id}`]);
    git(f.R, ["push", "-q", "origin", "--delete", `refs/heads/factory/${o.id}`]);
    assert.notEqual(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/factory/${o.id}`], { cwd: f.R }).status, 0);
    o.must(["set", o.job, "stage=merged"]);
    o.must(["note", o.job, "--text", `merged ${mergeSha.slice(0, 7)} on 2026-10-28`]);
    o.must(["release", o.job]);
  };

  o.commit = (files, msg) => commitFiles(o.W, files, msg);
  o.writeBuild = (P, text) => writeFileSync(path.join(o.J, `build-${P}.md`), text, { flag: "a" });
  return o;
}
