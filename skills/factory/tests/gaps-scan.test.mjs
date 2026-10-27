import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isSecretLine } from "../bin/lib/secrets.mjs";
import { ctl, makeEnv, setup, tempDir, writeJson } from "./helpers.mjs";

const gap = (overrides = {}) => ({
  kind: "builder", specialty: "react-ui", package: "P2", fallback: "factory-builder", reason: "no react specialist", ...overrides
});

test("gap appends once per (repo, job, kind, specialty); gaps groups by kind and specialty", () => {
  const s = setup();
  const file = (g) => writeJson(tempDir(), "gap.json", g);
  assert.deepEqual(ctl(s.env, ["gap", s.job, file(gap())]).out, ["ok"]);
  assert.equal(ctl(s.env, ["gap", s.job, file(gap({ reason: "again" }))]).code, 0);
  ctl(s.env, ["gap", s.job, file(gap({ kind: "reviewer", specialty: "a11y", package: null, fallback: null, reason: "no a11y lens" }))]);
  const other = setup();
  const otherEnv = { ...other.env, FACTORY_HOME: s.home };
  const reg = ctl(otherEnv, ["repo"], other.repoPath).out[0];
  const created = ctl(otherEnv, ["create", reg, writeJson(tempDir(), "j.json", { slug: "two", issue: null, title: "Two", feature: "f", target: "main" })]);
  ctl(otherEnv, ["gap", `${reg}/${created.out[0]}`, file(gap({ reason: "second repo" }))]);
  const lines = readFileSync(path.join(s.home, "gaps.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const groups = JSON.parse(ctl(s.env, ["gaps"]).out.join("\n"));
  assert.equal(groups[0].specialty, "react-ui");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].jobs.length, 2);
  assert.deepEqual(groups[0].reasons, ["no react specialist", "second repo"]);
  assert.equal(groups[1].kind, "reviewer");
});

test("gap validates its input and ignores corrupt ledger lines", () => {
  const s = setup();
  const bad = [
    gap({ kind: "tester" }), gap({ specialty: "React UI" }), gap({ package: "P0" }), gap({ fallback: "rogue-agent" }),
    gap({ reason: "has `ticks`" }), { ...gap(), extra: 1 }
  ];
  bad.forEach((g) => assert.equal(ctl(s.env, ["gap", s.job, writeJson(tempDir(), "g.json", g)]).code, 2, JSON.stringify(g)));
  assert.equal(ctl(s.env, ["gap", s.job, "/no/file"]).code, 2);
  assert.equal(ctl(s.env, ["gap", s.job]).code, 2);
  writeFileSync(path.join(s.home, "gaps.jsonl"), "not json\n42\n");
  assert.equal(ctl(s.env, ["gap", s.job, writeJson(tempDir(), "g.json", gap())]).code, 0);
  assert.equal(JSON.parse(ctl(s.env, ["gaps"]).out.join("\n")).length, 1);
  assert.equal(ctl(s.env, ["gaps", "extra"]).code, 2);
});

test("an empty ledger groups to [], and a symlinked ledger is tampering", () => {
  const env = makeEnv(tempDir());
  assert.deepEqual(JSON.parse(ctl(env, ["gaps"]).out.join("\n")), []);
  symlinkSync("/etc/hostname", path.join(env.FACTORY_HOME, "gaps.jsonl"));
  assert.equal(ctl(env, ["gaps"]).code, 3);
});

test("secret patterns: true positives", () => {
  const filler = "A1b2C3d4E5f6G7h8I9j0K1l2";
  [
    `token=ghp_${filler}`, `gho_${filler}`, `ghs_${filler}`, `ghu_${filler}`, `github_pat_${filler}`,
    `key: sk-${filler}`, `ANTHROPIC=sk-ant-api03-${filler}`, `sk_live_${filler}`, `sk_test_${filler}`,
    "aws AKIAABCDEFGHIJKLMNOP", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----",
    `xoxb-1234567890-${filler}`, `eyJ${filler}.eyJ${filler}.${filler}`
  ].forEach((line) => assert.ok(isSecretLine(line), line));
});

test("secret patterns: false positives stay quiet", () => {
  [
    "task-description-of-the-feature-for-humans",
    "use sk-learn for this", "desk-lamp-assembly-instructions-long-name",
    "AKIA is the AWS key prefix", "ghp_short", "the -----BEGIN CERTIFICATE----- block", "eyJhbGciOi"
  ].forEach((line) => assert.ok(!isSecretLine(line), line));
});

test("scan prints file:line per hit, exits 1, never echoes the secret", () => {
  const env = makeEnv(tempDir());
  const dir = tempDir();
  const dirty = path.join(dir, "dirty.patch");
  const clean = path.join(dir, "clean.md");
  const secret = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2";
  writeFileSync(dirty, `line one\n+const t = "${secret}";\n`);
  writeFileSync(clean, "nothing here\n");
  const res = ctl(env, ["scan", clean, dirty]);
  assert.equal(res.code, 1);
  assert.deepEqual(res.out, [`${dirty}:2`]);
  assert.ok(!res.out.join("").includes(secret));
  assert.equal(ctl(env, ["scan", clean]).code, 0);
  assert.equal(ctl(env, ["scan"]).code, 2);
  assert.equal(ctl(env, ["scan", path.join(dir, "missing")]).code, 2);
});
