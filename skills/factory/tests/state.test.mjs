import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ctl, setup, tempDir } from "./helpers.mjs";

const state = (s) => JSON.parse(readFileSync(path.join(s.dir, "state.json"), "utf8"));
const writeJobFile = (s, name, text) => {
  mkdirSync(path.dirname(path.join(s.dir, name)), { recursive: true });
  writeFileSync(path.join(s.dir, name), text);
};
const tmpFile = (text) => {
  const file = path.join(tempDir(), "in.md");
  writeFileSync(file, text);
  return file;
};

// A job with two packages and lenses set directly, as plan would.
function planned(lenses = ["code", "security"]) {
  const s = setup();
  const st = state(s);
  const packages = [
    { id: "P1", title: "Api", agent: "factory-builder-typescript", gap: null, status: "pending" },
    { id: "P2", title: "Ui", agent: "factory-builder", gap: "react-ui", status: "pending" }
  ];
  writeFileSync(path.join(s.dir, "state.json"), `${JSON.stringify({ ...st, packages, lenses }, null, 2)}\n`);
  s.hash = ctl(s.env, ["hash", s.job]).out[0];
  return s;
}

test("set changes token fields and validates the result", () => {
  const s = setup({ input: { issue: 7, slug: "fix-it" } });
  const sha = "a".repeat(40);
  const ok = s.mut(["set", s.job, `branch=factory/${s.id}`, `base=${sha}`, `head=${sha}`, "linked=true", "rework=2", "stage=build"]);
  assert.equal(ok.code, 0, ok.err);
  const st = state(s);
  assert.equal(st.branch, `factory/${s.id}`);
  assert.equal(st.linked, true);
  assert.equal(st.rework, 2);
  assert.equal(s.mut(["set", s.job, "linked=false", "pr=https://github.com/o/r/pull/9", "decision=APPROVE (human)"]).code, 0);
  assert.equal(s.mut(["set", s.job, "linked=null", "pr=null", "base=null"]).code, 0);
  assert.equal(state(s).base, null);
  const before = readFileSync(path.join(s.dir, "state.json"), "utf8");
  ["constructor=x", "toString=x", "note=hi", "feature=x", "=x", "noequals", "stage=done", "linked=maybe",
    "rework=x", "rework=11", "branch=factory/other", `worktree=${tempDir()}`, "pr=https://evil.com/x/y/pull/1"]
    .forEach((pair) => assert.equal(s.mut(["set", s.job, pair]).code, 2, pair));
  assert.equal(readFileSync(path.join(s.dir, "state.json"), "utf8"), before, "nothing written on a rejected set");
  assert.equal(s.mut(["set", s.job]).code, 2);
});

test("note --text, --append (trimmed from the left) and charset", () => {
  const s = setup();
  assert.equal(s.mut(["note", s.job, "--text", "building P1"]).code, 0);
  assert.equal(s.mut(["note", s.job, "--append", "(github: board move)"]).code, 0);
  assert.equal(state(s).note, "building P1 (github: board move)");
  assert.equal(s.mut(["note", s.job, "--text", "x".repeat(150)]).code, 0);
  assert.equal(s.mut(["note", s.job, "--append", "tail-end"]).code, 0);
  assert.ok(state(s).note.length <= 160 && state(s).note.length >= 159);
  assert.ok(state(s).note.endsWith("tail-end"));
  assert.equal(s.mut(["note", s.job, "--text", "$(rm -rf /)"]).code, 2);
  assert.equal(s.mut(["note", s.job, "--bogus", "x"]).code, 2);
  assert.equal(s.mut(["note", s.job, "--text"]).code, 2);
});

test("note --line sanitises, flags secrets, and stays inside the job folder", () => {
  const s = setup();
  writeJobFile(s, "decision.md", "ESCALATE\nneeds `human` <sign-off> on $deps\n\nkey ghp_abcdefghijklmnopqrstuvwxyz0123\n");
  assert.equal(s.mut(["note", s.job, "--line", "decision.md", "2"]).code, 0);
  assert.equal(state(s).note, "needs _human_ _sign-off_ on _deps");
  assert.equal(s.mut(["note", s.job, "--line", path.join(s.dir, "decision.md"), "4"]).code, 0);
  assert.equal(state(s).note, "possible secret in decision.md");
  assert.equal(s.mut(["note", s.job, "--line", "decision.md", "3"]).code, 0);
  assert.equal(state(s).note, "line 3 of decision.md is empty");
  assert.equal(s.mut(["note", s.job, "--line", "decision.md", "0"]).code, 2);
  assert.equal(s.mut(["note", s.job, "--line", "../../../etc/passwd", "1"]).code, 2);
  assert.equal(s.mut(["note", s.job, "--line", "state.json", "1"]).code, 2);
  assert.equal(s.mut(["note", s.job, "--line", "spec.md", "1"]).code, 5);
  symlinkSync("/etc/hostname", path.join(s.dir, "spec.md"));
  assert.equal(s.mut(["note", s.job, "--line", "spec.md", "1"]).code, 3);
});

test("pkg sets one package's status", () => {
  const s = planned();
  assert.equal(s.mut(["pkg", s.job, "P2", "building"]).code, 0);
  assert.deepEqual(state(s).packages.map((p) => p.status), ["pending", "building"]);
  assert.equal(s.mut(["pkg", s.job, "P3", "done"]).code, 2);
  assert.equal(s.mut(["pkg", s.job, "P1", "finished"]).code, 2);
  assert.equal(s.mut(["pkg", s.job, "Q1", "done"]).code, 2);
  assert.equal(s.mut(["pkg", s.job]).code, 2);
});

test("round opens a pending chip per lens; lens additions apply from the next round", () => {
  const s = planned();
  assert.equal(s.mut(["round", s.job]).code, 0);
  assert.deepEqual(state(s).rounds, [{ code: "pending", security: "pending" }]);
  assert.equal(state(s).stage, "review");
  assert.equal(state(s).note, "round 1: reviewing");
  const sameHash = s.hash;
  assert.equal(s.mut(["lens", s.job, "code"]).out[0], sameHash, "adding an existing lens is a no-op");
  assert.equal(s.mut(["lens", s.job, "ui"]).code, 0);
  assert.deepEqual(state(s).rounds[0], { code: "pending", security: "pending" });
  assert.equal(s.mut(["round", s.job]).code, 0);
  assert.deepEqual(state(s).rounds[1], { code: "pending", security: "pending", ui: "pending" });
  assert.equal(state(s).round, 2);
  assert.equal(s.mut(["lens", s.job, "Bad Lens"]).code, 2);
  assert.equal(s.mut(["lens", s.job]).code, 2);
  assert.equal(s.mut(["round", s.job, "extra"]).code, 2);
});

test("chip is PASS only on an exact first line; missing or symlinked files are CHANGES", () => {
  const s = planned(["code", "security", "ui"]);
  assert.equal(s.mut(["chip", s.job, "code", "round-1/review-code.md"]).code, 2, "no round yet");
  s.mut(["round", s.job]);
  writeJobFile(s, "round-1/review-code.md", "VERDICT: PASS\n\n## Findings\n- None\n");
  writeJobFile(s, "round-1/review-security.md", "VERDICT: PASS (mostly)\n");
  symlinkSync(path.join(s.dir, "round-1", "review-code.md"), path.join(s.dir, "round-1", "review-ui.md"));
  assert.equal(s.mut(["chip", s.job, "code", "round-1/review-code.md"]).code, 0);
  assert.equal(state(s).note, "round 1: waiting on security, ui");
  s.mut(["chip", s.job, "security", "round-1/review-security.md"]);
  s.mut(["chip", s.job, "ui", path.join(s.dir, "round-1", "review-ui.md")]);
  assert.deepEqual(state(s).rounds[0], { code: "PASS", security: "CHANGES", ui: "CHANGES" });
  assert.equal(state(s).note, "round 1: all reviews in");
  writeJobFile(s, "round-1/review-code.md", " VERDICT: PASS\n");
  s.mut(["chip", s.job, "code", "round-1/review-code.md"]);
  assert.equal(state(s).rounds[0].code, "CHANGES");
  writeJobFile(s, "round-1/review-code.md", "VERDICT: PASS\r\nok\r\n");
  s.mut(["chip", s.job, "code", "round-1/review-code.md"]);
  assert.equal(state(s).rounds[0].code, "PASS", "CRLF files still pass");
  s.mut(["chip", s.job, "code", "round-2/review-code.md"]);
  assert.equal(state(s).rounds[0].code, "CHANGES", "missing file");
  assert.equal(s.mut(["chip", s.job, "ux", "round-1/review-ux.md"]).code, 2, "lens not in round");
  assert.equal(s.mut(["chip", s.job, "code", "../state.json"]).code, 2);
  assert.equal(s.mut(["chip", s.job, "code"]).code, 2);
});

test("feedback appends verbatim and clears sign-off, decision and rework", () => {
  const s = setup();
  writeJobFile(s, "spec.md", "# Spec\n");
  s.mut(["signoff", s.job]);
  s.mut(["set", s.job, "rework=2", "decision=ESCALATE"]);
  assert.equal(s.mut(["feedback", s.job, tmpFile("Use `$(date)` as-is; don't run it.\n\n")]).code, 0);
  const st = state(s);
  assert.deepEqual(st.feedback, ["Use `$(date)` as-is; don't run it."]);
  assert.equal(st.signoff, null);
  assert.equal(st.decision, null);
  assert.equal(st.rework, 0);
  assert.equal(s.mut(["feedback", s.job, tmpFile("   \n")]).code, 2);
  assert.equal(s.mut(["feedback", s.job, tmpFile("x".repeat(4001))]).code, 2);
  assert.equal(s.mut(["feedback", s.job, "/no/such/file"]).code, 2);
  assert.equal(s.mut(["feedback", s.job]).code, 2);
});

test("signoff pins the spec hash; signoff-check fails after any spec edit", () => {
  const s = setup();
  assert.equal(s.mut(["signoff", s.job]).code, 5, "no spec yet");
  assert.equal(ctl(s.env, ["signoff-check", s.job]).code, 1, "nothing signed off");
  writeJobFile(s, "spec.md", "# Spec\n## Summary\nv1\n");
  assert.equal(ctl(s.env, ["signoff-check", s.job]).code, 1, "not signed off");
  assert.equal(s.mut(["signoff", s.job]).code, 0);
  assert.match(state(s).signoff, /^[0-9a-f]{64}$/);
  assert.equal(ctl(s.env, ["signoff-check", s.job]).code, 0);
  writeJobFile(s, "spec.md", "# Spec\n## Summary\nv2\n");
  assert.equal(ctl(s.env, ["signoff-check", s.job]).code, 1);
  assert.equal(ctl(s.env, ["signoff-check"]).code, 2);
  assert.equal(s.mut(["signoff", s.job, "extra"]).code, 2);
});
