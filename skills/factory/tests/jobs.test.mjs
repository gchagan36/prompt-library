import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findOwner, leaseStatus, psInfo } from "../bin/lib/lease.mjs";
import { OWNER_COMM, ctl, jobInput, makeEnv, makeRepo, setup, spawnCtl, tempDir, writeJson } from "./helpers.mjs";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const leaseFile = (s) => path.join(s.dir, "lease.json");
const stateFile = (s) => path.join(s.dir, "state.json");
const deadPid = () => spawnSync("true").pid;

test("repo registers a stable key shared by every worktree, with credentials stripped", () => {
  const home = tempDir();
  const env = makeEnv(home);
  const root = makeRepo({ "a.txt": "a" }, "My Repo.v2");
  spawnSync("git", ["remote", "add", "origin", "https://user:secret@github.com/o/r.git"], { cwd: root });
  const key = ctl(env, ["repo"], root).out[0];
  assert.match(key, /^my-repo-v2-[0-9a-f]{8}$/);
  spawnSync("git", ["worktree", "add", "-q", path.join(root, "wt"), "-b", "x"], { cwd: root });
  assert.equal(ctl(env, ["repo"], path.join(root, "wt")).out[0], key);
  const info = readJson(path.join(home, "repos", key, "repo.json"));
  assert.equal(info.path, root);
  assert.equal(info.remote, "https://github.com/o/r.git");
  assert.equal(ctl(env, ["repo"], tempDir()).code, 2);
  assert.equal(ctl(env, ["repo", "extra"], root).code, 2);
});

test("create writes a spec-stage state, a live lease, and prints id, token, hash", () => {
  const s = setup({ input: { issue: 57, slug: "last-run" } });
  assert.match(s.id, /^001-i57-last-run$/);
  const state = readJson(stateFile(s));
  assert.equal(state.stage, "spec");
  assert.equal(state.note, "writing spec");
  assert.deepEqual(state.lenses, ["code"]);
  const lease = readJson(leaseFile(s));
  assert.equal(lease.token, undefined, "the token itself never touches disk");
  assert.equal(lease.pid, process.ppid);
  assert.equal(ctl(s.env, ["hash", s.job]).out[0], s.hash);
  assert.equal(JSON.parse(ctl(s.env, ["show", s.job]).out.join("\n")).id, s.id);
  assert.equal(readFileSync(path.join(s.dir, "state.prev.json"), "utf8"), readFileSync(stateFile(s), "utf8"));
});

test("create rejects bad input, unknown repos and issue-shaped slugs without an issue", () => {
  const s = setup();
  const make = (input) => ctl(s.env, ["create", s.repo, writeJson(tempDir(), "j.json", input)]).code;
  assert.equal(make({ ...jobInput(), slug: "Bad Slug" }), 2);
  assert.equal(make({ ...jobInput(), extra: 1 }), 2);
  assert.equal(make({ ...jobInput(), issue: 0 }), 2);
  assert.equal(make({ ...jobInput(), title: 5 }), 2);
  assert.equal(make({ ...jobInput(), feature: "   " }), 2);
  assert.equal(make({ ...jobInput(), target: "-evil" }), 2);
  assert.equal(make({ ...jobInput(), slug: "i5-thing" }), 2);
  assert.equal(ctl(s.env, ["create", "nope-00000000", writeJson(tempDir(), "j.json", jobInput())]).code, 5);
  assert.equal(ctl(s.env, ["create", s.repo, "/no/such/file"]).code, 2);
  assert.equal(ctl(s.env, ["create", s.repo, writeJson(tempDir(), "j.json", jobInput()), "--min", "x"]).code, 2);
  assert.equal(ctl(s.env, ["create", s.repo]).code, 2);
});

test("ids are sequential per repo and honour --min", () => {
  const s = setup();
  const file = writeJson(tempDir(), "j.json", jobInput({ slug: "next" }));
  assert.equal(ctl(s.env, ["create", s.repo, file]).out[0], "002-next");
  assert.equal(ctl(s.env, ["create", s.repo, file, "--min", "40"]).out[0], "040-next");
  assert.equal(ctl(s.env, ["create", s.repo, file]).out[0], "041-next");
});

test("8 concurrent creates from separate processes get unique ids", async () => {
  const s = setup();
  const runs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => spawnCtl(s.env, ["create", s.repo, writeJson(tempDir(), "j.json", jobInput({ slug: `job-${i}` }))]))
  );
  runs.forEach((r) => assert.equal(r.code, 0, r.err));
  const numbers = runs.map((r) => r.out[0].slice(0, 3));
  assert.equal(new Set(numbers).size, 8);
});

test("a live lease blocks claim; a wrong token is refused", () => {
  const s = setup();
  const claim = ctl(s.env, ["claim", s.job]);
  assert.equal(claim.code, 6);
  assert.match(claim.err, /pid \d+/);
  assert.equal(ctl(s.env, ["set", s.job, "stage=build", "--lease", "0".repeat(32), "--expect", s.hash]).code, 6);
  assert.equal(ctl(s.env, ["claim", s.job, "--steal"]).code, 2);
  assert.equal(ctl(s.env, ["claim", "bad"]).code, 2);
  assert.equal(ctl(s.env, ["claim", `${s.repo}/099-missing`]).code, 5);
});

test("dead owner, reused pid, other host and expired TTL all free the lease", () => {
  const s = setup();
  const lease = readJson(leaseFile(s));
  const variants = [
    { ...lease, pid: deadPid() },
    { ...lease, pid: process.pid, pstart: "Mon Jan  1 00:00:00 2001" },
    { ...lease, host: `${hostname()}-other` },
    { ...lease, pid: null, pstart: null, claimed: "2000-01-01T00:00:00Z" }
  ];
  variants.forEach((v) => assert.equal(leaseStatus(v, s.env), "free"));
  assert.equal(leaseStatus({ ...lease, pid: null, pstart: null, claimed: new Date().toISOString() }, s.env), "live");
  assert.equal(leaseStatus({ ...lease, pid: null, claimed: new Date(Date.now() - 120_000).toISOString() }, { FACTORY_LEASE_TTL_MIN: "1" }), "free");
  assert.equal(leaseStatus(null, s.env), "free");
  writeFileSync(leaseFile(s), JSON.stringify(variants[0]));
  const claim = ctl(s.env, ["claim", s.job]);
  assert.equal(claim.code, 0, claim.err);
  assert.equal(claim.out[1], s.hash);
  assert.equal(ctl(s.env, ["set", s.job, "stage=build", "--lease", s.token, "--expect", s.hash]).code, 6, "old token is dead");
});

test("claim never hands a live lease to its own session again (no reclaim)", () => {
  const s = setup();
  assert.equal(ctl(s.env, ["claim", s.job, "--reclaim"]).code, 2, "reclaim is not a command");
  assert.equal(ctl(s.env, ["claim", s.job]).code, 6, "same live owner still can't claim");
  assert.equal(s.mut(["set", s.job, "stage=signoff"]).code, 0, "the original token still works");
});

test("owner detection walks to the named ancestor, or gives nulls", () => {
  assert.equal(findOwner({ FACTORY_OWNER_COMM: OWNER_COMM }).pid, process.ppid);
  assert.deepEqual(findOwner({ FACTORY_OWNER_COMM: "no-such-comm" }), { pid: null, pstart: null });
  assert.equal(psInfo(-1), null);
  assert.equal(psInfo(deadPid()), null);
});

test("release only at a resting stage, then any session can claim", () => {
  const s = setup();
  assert.equal(ctl(s.env, ["release", s.job, "--lease", s.token, "--expect", s.hash]).code, 2);
  assert.equal(s.mut(["set", s.job, "stage=signoff"]).code, 0);
  assert.equal(ctl(s.env, ["release", s.job, "--lease", s.token, "--expect", "f".repeat(64)]).code, 3);
  assert.equal(ctl(s.env, ["release", s.job, "--lease", s.token, "--expect", s.hash]).code, 0);
  assert.ok(readJson(leaseFile(s)).released);
  assert.equal(JSON.parse(ctl(s.env, ["list"]).out.join("\n"))[0].lease, "released");
  assert.equal(s.mut(["set", s.job, "stage=build"]).code, 6, "released token can't write");
  assert.equal(ctl(s.env, ["claim", s.job]).code, 0);
  assert.equal(ctl(s.env, ["release", s.job]).code, 2);
});

test("expect mismatch writes nothing; a symlinked state.json is tampering", () => {
  const s = setup();
  const before = readFileSync(stateFile(s), "utf8");
  assert.equal(ctl(s.env, ["set", s.job, "stage=build", "--lease", s.token, "--expect", "a".repeat(64)]).code, 3);
  assert.equal(readFileSync(stateFile(s), "utf8"), before);
  const real = path.join(s.dir, "real.json");
  renameSync(stateFile(s), real);
  symlinkSync(real, stateFile(s));
  assert.equal(s.mut(["set", s.job, "stage=build"]).code, 3);
  assert.equal(ctl(s.env, ["hash", s.job]).code, 3);
  unlinkSync(stateFile(s));
  assert.equal(ctl(s.env, ["hash", s.job]).code, 5);
});

test("restore puts the last written state back; a tampered backup exits 4", () => {
  const s = setup();
  const good = readFileSync(stateFile(s), "utf8");
  writeFileSync(stateFile(s), good.replace("writing spec", "forged note"));
  assert.equal(ctl(s.env, ["restore", s.job, s.hash, "--lease", s.token]).out[0], s.hash);
  assert.equal(readFileSync(stateFile(s), "utf8"), good);
  writeFileSync(path.join(s.dir, "state.prev.json"), "{}");
  assert.equal(ctl(s.env, ["restore", s.job, s.hash, "--lease", s.token]).code, 4);
  unlinkSync(path.join(s.dir, "state.prev.json"));
  assert.equal(ctl(s.env, ["restore", s.job, s.hash, "--lease", s.token]).code, 4);
  assert.equal(ctl(s.env, ["restore", s.job, s.hash, "--lease", "0".repeat(32)]).code, 6);
  assert.equal(ctl(s.env, ["restore", s.job, s.hash]).code, 2);
});

test("validate and list flag invalid jobs; list filters by repo", () => {
  const s = setup();
  assert.deepEqual(ctl(s.env, ["validate"]).out, ["ok"]);
  assert.deepEqual(ctl(s.env, ["validate", s.repo]).out, ["ok"]);
  const state = readJson(stateFile(s));
  writeFileSync(stateFile(s), JSON.stringify({ ...state, stage: "bogus" }));
  const v = ctl(s.env, ["validate"]);
  assert.equal(v.code, 2);
  assert.match(v.err, /invalid stage/);
  const rows = JSON.parse(ctl(s.env, ["list", "--repo", s.repo]).out.join("\n"));
  assert.equal(rows[0].invalid, "invalid stage");
  writeFileSync(stateFile(s), "not json");
  assert.match(JSON.parse(ctl(s.env, ["list"]).out.join("\n"))[0].invalid, /JSON/);
  assert.equal(ctl(s.env, ["list", "--bogus"]).code, 2);
  assert.equal(ctl(s.env, ["validate", "a", "b"]).code, 2);
});

test("a working job whose owner died is listed as an orphan", () => {
  const s = setup();
  writeFileSync(leaseFile(s), JSON.stringify({ ...readJson(leaseFile(s)), pid: deadPid() }));
  const row = JSON.parse(ctl(s.env, ["list"]).out.join("\n"))[0];
  assert.equal(row.lease, "free");
  assert.equal(row.orphan, true);
});

test("cli: usage, help, unknown commands, and malformed auth", () => {
  const env = makeEnv(tempDir());
  assert.equal(ctl(env, []).code, 2);
  assert.equal(ctl(env, ["help"]).code, 0);
  assert.equal(ctl(env, ["frobnicate"]).code, 2);
  assert.equal(ctl(env, ["set", "x/y", "--lease", "nothex", "--expect", "a".repeat(64)]).code, 2);
  assert.equal(ctl(env, ["set", "x/y"]).code, 2);
  assert.equal(existsSync(path.join(env.FACTORY_HOME, "repos")), false);
});
