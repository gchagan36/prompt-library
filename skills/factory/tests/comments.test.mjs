import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { addedLines, commentOf, markerIndex, renderScan, scanDiff, scanText } from "../bin/lib/comments.mjs";
import { commitFiles, ctl, git, setup } from "./helpers.mjs";

const rules = (text, opts) => scanText(text, opts).map((h) => h.rule);
const JS = { line: "//", block: ["/*", "*/"] };
const PY = { line: "#", doc: true };

test("markerIndex ignores markers inside strings and URLs", () => {
  assert.equal(markerIndex("x = 1 // note", "//"), 6);
  assert.equal(markerIndex('const u = "http://a//b"; // c', "//"), 25);
  assert.equal(markerIndex("fetch('https://x.io')", "//"), -1);
  assert.equal(markerIndex('s = "a # b"  # real', "#"), 13);
  assert.equal(markerIndex("echo $# args", "#"), -1);
});

test("commentOf extracts line, inline, block and docstring comments", () => {
  assert.equal(commentOf(JS, "// why", { close: null }), " why");
  assert.equal(commentOf(JS, "let a = 1;", { close: null }), null);
  const st = { close: null };
  assert.equal(commentOf(JS, "/** Start", st), "* Start");
  assert.equal(st.close, "*/");
  assert.equal(commentOf(JS, " * middle", st), " * middle");
  assert.equal(commentOf(JS, " */ code()", st), " ");
  assert.equal(st.close, null);
  const py = { close: null };
  assert.equal(commentOf(PY, '    """One line."""', py), "One line.");
  assert.equal(commentOf(PY, '    r"""Opens', py), "Opens");
  assert.equal(commentOf(PY, "    body text", py), "    body text");
  assert.equal(commentOf(PY, '    """', py), "    ");
  assert.equal(py.close, null);
  assert.equal(commentOf({ line: "//", block: ["<!--", "-->"] }, "<div> <!-- see #4 -->", { close: null }), " see #4 ");
});

test("scanText flags tracker, process and history references", () => {
  for (const t of ["fixes #123", "see GH-45", "blocked on PROJ-678", "https://github.com/o/r/issues/9",
    "https://acme.atlassian.net/browse/X", "per the ticket", "PR 42 changed this"]) {
    assert.ok(rules(t).includes("tracker"), t);
  }
  for (const t of ["covers AC-3", "added in review round 2", "per the spec", "as the reviewer asked", "see spec.md",
    "as discussed", "per our meeting"]) {
    assert.ok(rules(t).includes("process"), t);
  }
  for (const t of ["previously this cached", "now uses the pool", "changed from 30s", "no longer retries",
    "temporary fix for startup", "New: batch mode"]) {
    assert.ok(rules(t).includes("history"), t);
  }
});

test("scanText leaves ordinary explanatory comments alone", () => {
  for (const t of ["Copied verbatim from the table in docs/supervision.md;",
    "Retries stop at 5 so a dead host can't stall the queue.", "UTF-8 only; SHA-256 of the body",
    "See RFC-7231 section 6", "step-by-step parse", "CVE-2021-44228 mitigation: no lookups",
    "TODO: switch to streaming once responses exceed 10 MB", "Docs: https://nodejs.org/api/fs.html"]) {
    assert.deepEqual(rules(t), [], t);
  }
});

test("scanText flags unexplained TODOs and commented-out code", () => {
  assert.deepEqual(rules("TODO fix"), ["todo"]);
  assert.deepEqual(rules("FIXME #12"), ["tracker", "todo"]);
  for (const t of ["const x = load();", "return cache.get(key);", "console.log(state)", "doThing(a, b);", "if (a) {"]) {
    assert.ok(rules(t).includes("commented-code"), t);
  }
});

test("docs mode checks tracker and process only; changelogs keep tracker references", () => {
  assert.deepEqual(rules("Fixed in #44", { docs: true }), ["tracker"]);
  assert.deepEqual(rules("Previously the CLI printed JSON.", { docs: true }), []);
  assert.deepEqual(rules("- Faster sync (#44)", { docs: true, changelog: true }), []);
  assert.deepEqual(rules("- Done per the spec", { docs: true, changelog: true }), ["process"]);
  assert.deepEqual(rules("SPDX-License-Identifier: MIT #1"), []);
  assert.deepEqual(rules("see GH-45 and #3"), ["tracker"], "one hit per rule family");
  assert.deepEqual(rules("covers AC-3"), ["process"], "AC numbers are process, not tracker ids");
});

const DIFF = [
  "diff --git a/lib/a.ts b/lib/a.ts",
  "--- a/lib/a.ts",
  "+++ b/lib/a.ts",
  "@@ -3,0 +4,3 @@",
  "+const url = \"see #99\"; // fixes #12",
  "+/* previously",
  "+ * cached */",
  "@@ -20 +23 @@",
  "+// TODO later",
  "--- a/old.py",
  "+++ /dev/null",
  "+++ b/README.md",
  "@@ -1,0 +1 @@",
  "+Tracked in PROJ-9.",
  "+++ b/data.xyz",
  "@@ -1,0 +1 @@",
  "+# fixes #3"
].join("\n");

test("addedLines follows hunk line numbers and skips deleted files", () => {
  const lines = addedLines(DIFF);
  assert.deepEqual(lines.map((l) => `${l.file}:${l.line}`), ["lib/a.ts:4", "lib/a.ts:5", "lib/a.ts:6", "lib/a.ts:23", "README.md:1", "data.xyz:1"]);
});

test("scanDiff scans comments and docs, never string literals, and reports unknown syntax", () => {
  const { candidates, scanned, skipped } = scanDiff(DIFF);
  assert.deepEqual(candidates.map((c) => `${c.file}:${c.line} ${c.rule}`), [
    "lib/a.ts:4 tracker", "lib/a.ts:5 history", "lib/a.ts:23 todo", "README.md:1 tracker"
  ]);
  assert.equal(scanned, 5);
  assert.deepEqual(skipped, ["data.xyz"]);
});

test("renderScan escapes table cells, hides secrets, and caps rows", () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ file: "a|b`.ts", line: i + 1, rule: "tracker", match: "#1" }));
  const secret = { file: "k.ts", line: 1, rule: "tracker", match: `ghp_${"a".repeat(30)} #1` };
  const md = renderScan({ candidates: [secret, ...many], scanned: 206, skipped: ["x.bin"] }, { round: 2, base: "a".repeat(40), head: "b".repeat(40) });
  assert.match(md, /^# Comment scan: round 2/);
  assert.match(md, /possible secret/);
  assert.doesNotMatch(md, /ghp_a/);
  assert.match(md, /`a'b'\.ts:1`/);
  assert.match(md, /Showing the first 200\./);
  assert.match(md, /Not scanned \(unknown syntax\): `x\.bin`/);
  assert.equal((md.match(/^\| `/gm) || []).length, 200);
  assert.match(renderScan({ candidates: [], scanned: 0, skipped: [] }, { round: 1, base: "a".repeat(40), head: "b".repeat(40) }), /No candidates\./);
});

test("comments command writes round-<r>/comments-scan.md and prints the count", () => {
  const s = setup();
  const wt = path.join(s.home, "repos", s.repo, "worktrees", s.id);
  git(s.repoPath, ["worktree", "add", "-q", "-b", `factory/${s.id}`, wt, "HEAD"]);
  const base = git(wt, ["rev-parse", "HEAD"]);
  const head = commitFiles(wt, { "lib/x.ts": "// fixes #7\nexport const x = 1; // why: keeps ids stable\n" });
  assert.equal(ctl(s.env, ["comments", s.job, "1"]).code, 2, "no round yet");
  assert.equal(s.mut(["set", s.job, `worktree=${wt}`, `base=${base}`, `head=${head}`, `branch=factory/${s.id}`]).code, 0);
  assert.equal(s.mut(["round", s.job]).code, 0);
  assert.equal(ctl(s.env, ["comments", s.job, "1"]).code, 5, "no round folder");
  mkdirSync(path.join(s.dir, "round-1"));
  const res = ctl(s.env, ["comments", s.job, "1"]);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(res.out.filter(Boolean), ["1"]);
  const md = readFileSync(path.join(s.dir, "round-1/comments-scan.md"), "utf8");
  assert.match(md, /`lib\/x\.ts:1` \| tracker \| `#7`/);
  assert.equal(ctl(s.env, ["comments", s.job, "x"]).code, 2);
  assert.equal(ctl(s.env, ["comments", s.job, "2"]).code, 2);
  assert.equal(ctl(s.env, ["comments", s.job]).code, 2);
});
