import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreeDir } from "../bin/lib/paths.mjs";
import { PATTERNS, invalidField, isTarget } from "../bin/lib/validate.mjs";

const home = "/tmp/fh";
const base = () => ({
  schema: 1, id: "004-i57-last-run", repo: "scout-1a2b3c4d", title: "Last Run", feature: "show it", issue: 57,
  target: "develop", branch: null, linked: null, worktree: null, base: null, head: null, stage: "spec",
  signoff: null, packages: [], lenses: ["code"], round: 0, rounds: [], rework: 0, feedback: [], decision: null,
  pr: null, note: "writing spec", created: "2026-10-27T18:00:00Z", updated: "2026-10-27T18:00:00Z"
});
const field = (patch, ctx = { home }) => invalidField({ ...base(), ...patch }, ctx);

const cases = {
  id: [["001-ab", "123-i9-a-b-c-d"], ["1-ab", "001", "001-AB", "001-a-b-c-d-e", "001_ab"]],
  repo: [["scout-1a2b3c4d", "-x-00000000"], ["Scout-1a2b3c4d", "scout-1a2b3c4", "scout1a2b3c4d"]],
  title: [["Last Run (v2) #3, a/b-c."], ["", "x".repeat(61), "bad;title", "emoji 🎉"]],
  sha: [["a".repeat(40)], ["a".repeat(39), "A".repeat(40), "g".repeat(40)]],
  sha256: [["0".repeat(64)], ["0".repeat(63)]],
  token: [["f".repeat(32)], ["f".repeat(31), "F".repeat(32)]],
  pkgId: [["P1", "P9"], ["P0", "P10", "p1"]],
  agent: [["factory-builder", "factory-builder-typescript", "factory-builder-a-b-c"], ["factory-builder-a-b-c-d", "factory-review-code", "builder"]],
  gap: [["react-ui", "a-b-c-d"], ["a-b-c-d-e", "React", "-x"]],
  lens: [["code", "a11y", "a-b-c"], ["a-b-c-d", "Code", ""]],
  pr: [["https://github.com/o/r/pull/12"], ["http://github.com/o/r/pull/1", "https://github.com/o/r/issues/1", "https://github.com/o/r/pull/1/files", "https://evil.com/o/r/pull/1"]],
  note: [["round 1: waiting on ux, ui (#5) a/b_c+d=e-f"], ["mention @someone", "", "x".repeat(161), "has `tick`", "dollar $x", "new\nline"]],
  stamp: [["2026-10-27T18:00:00Z"], ["2026-10-27T18:00:00.123Z", "2026-10-27 18:00:00Z"]]
};

for (const [name, [good, bad]] of Object.entries(cases)) {
  test(`pattern ${name} accepts and rejects`, () => {
    good.forEach((v) => assert.ok(PATTERNS[name].test(v), `${name} should accept ${v}`));
    bad.forEach((v) => assert.ok(!PATTERNS[name].test(v), `${name} should reject ${v}`));
  });
}

test("target: branch names only, no .., no leading dash", () => {
  ["develop", "release/1.2", "feature_x"].forEach((t) => assert.ok(isTarget(t), t));
  ["", "-x", "a..b", "a b", "x".repeat(101), 5].forEach((t) => assert.ok(!isTarget(t), String(t)));
});

test("a valid state has no invalid field", () => {
  assert.equal(field({}), null);
});

test("each field rule rejects a bad value", () => {
  const bad = {
    schema: 2, title: "bad;", feature: "", issue: 58, target: "-x", branch: "factory/other", linked: "yes",
    worktree: "/elsewhere", base: "abc", head: "abc", stage: "done", signoff: "x", packages: {},
    lenses: ["security"], rounds: [{ code: "maybe" }], round: 3, rework: 11, feedback: [""], decision: "YES",
    pr: "https://x", note: "", created: "now", updated: "now"
  };
  Object.entries(bad).forEach(([k, v]) => assert.equal(field({ [k]: v }), k, `field ${k}`));
});

test("issue must match the id's i<N> in both directions", () => {
  assert.equal(field({ issue: null }), "issue");
  assert.equal(field({ id: "004-plain-job", issue: 57 }), "issue");
  assert.equal(field({ id: "004-plain-job", issue: null }), null);
  assert.equal(field({ id: "004-i057-x", issue: 57 }), "issue");
});

test("unknown, missing and inherited keys are invalid", () => {
  assert.match(field({ extra: 1 }), /^unknown key extra$/);
  const { note, ...withoutNote } = base();
  assert.equal(invalidField(withoutNote, { home }), "note");
  assert.equal(invalidField(Object.assign(Object.create({ note: "x" }), withoutNote), { home }), "note");
  assert.equal(invalidField(null, { home }), "state");
  assert.equal(invalidField([], { home }), "state");
  assert.equal(note, "writing spec");
});

test("branch and worktree are pinned to the job", () => {
  assert.equal(field({ branch: "factory/004-i57-last-run" }), null);
  assert.equal(field({ worktree: worktreeDir(home, "scout-1a2b3c4d", "004-i57-last-run") }), null);
});

test("id and repo are pinned to the folder they were read from", () => {
  assert.equal(field({}, { home, id: "005-other" }), "id");
  assert.equal(field({}, { home, repo: "other-1a2b3c4d" }), "repo");
});

test("packages: shape, order, uniqueness, max 9", () => {
  const p = (id, extra = {}) => ({ id, title: "Pkg", agent: "factory-builder-ts", gap: null, status: "pending", ...extra });
  assert.equal(field({ packages: [p("P1"), p("P3")] }), null);
  assert.equal(field({ packages: [p("P2"), p("P1")] }), "packages");
  assert.equal(field({ packages: [p("P1"), p("P1")] }), "packages");
  assert.equal(field({ packages: [p("P1", { status: "bogus" })] }), "packages");
  assert.equal(field({ packages: [p("P1", { extra: 1 })] }), "packages");
  assert.equal(field({ packages: Array.from({ length: 10 }, (_, i) => p(`P${(i % 9) + 1}`)) }), "packages");
});

test("lenses must be unique and include code; rounds use known lenses", () => {
  assert.equal(field({ lenses: ["code", "code"] }), "lenses");
  assert.equal(field({ lenses: [] }), "lenses");
  assert.equal(field({ lenses: ["code", "ui"], rounds: [{ code: "PASS" }, { code: "pending", ui: "pending" }], round: 2 }), null);
  assert.equal(field({ lenses: ["code"], rounds: [{ code: "PASS", ui: "PASS" }], round: 1 }), "rounds");
  assert.equal(field({ rounds: [{}], round: 1 }), "rounds");
});
