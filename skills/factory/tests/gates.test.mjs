// The helper-enforced gates on the transitions that lead to a PR, and the glob bounds.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { globToRegExp, isGlob, matchGlob } from "../bin/lib/glob.mjs";
import { ctl, setup } from "./helpers.mjs";

const state = (s) => JSON.parse(readFileSync(path.join(s.dir, "state.json"), "utf8"));

// A job with lenses code+security, one review round, and a spec on disk.
function reviewed() {
  const s = setup();
  const st = state(s);
  writeFileSync(path.join(s.dir, "state.json"), `${JSON.stringify({ ...st, lenses: ["code", "security"] }, null, 2)}\n`);
  s.hash = ctl(s.env, ["hash", s.job]).out[0];
  writeFileSync(path.join(s.dir, "spec.md"), "# Spec\n");
  assert.equal(s.mut(["round", s.job]).code, 0);
  mkdirSync(path.join(s.dir, "round-1"));
  s.review = (lens, first) => {
    writeFileSync(path.join(s.dir, `round-1/review-${lens}.md`), `${first}\n\nbody\n`);
    return s.mut(["chip", s.job, lens, `round-1/review-${lens}.md`]);
  };
  return s;
}

test("decision=APPROVE needs every lens PASS in the last round and a matching sign-off", () => {
  const s = reviewed();
  s.review("code", "VERDICT: PASS");
  s.review("security", "VERDICT: CHANGES");
  assert.equal(s.mut(["signoff", s.job]).code, 0);
  assert.equal(s.mut(["set", s.job, "decision=APPROVE"]).code, 2, "a CHANGES chip blocks");
  s.review("security", "VERDICT: PASS");
  writeFileSync(path.join(s.dir, "spec.md"), "# Spec, edited after sign-off\n");
  assert.equal(s.mut(["set", s.job, "decision=APPROVE"]).code, 2, "stale sign-off blocks");
  assert.equal(s.mut(["signoff", s.job]).code, 0);
  const ok = s.mut(["set", s.job, "decision=APPROVE"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(state(s).decision, "APPROVE");
});

test("decision=APPROVE without any round is refused; ESCALATE and human approval are not gated", () => {
  const s = setup();
  assert.equal(s.mut(["set", s.job, "decision=APPROVE"]).code, 2);
  assert.equal(s.mut(["set", s.job, "decision=ESCALATE"]).code, 0);
  assert.equal(s.mut(["set", s.job, "decision=APPROVE (human)"]).code, 0);
});

test("stage=pr-open needs an approval and a PR URL", () => {
  const s = setup();
  const pr = "pr=https://github.com/o/r/pull/3";
  assert.equal(s.mut(["set", s.job, "stage=pr-open", pr]).code, 2, "no decision");
  assert.equal(s.mut(["set", s.job, "decision=ESCALATE"]).code, 0);
  assert.equal(s.mut(["set", s.job, "stage=pr-open", pr]).code, 2, "escalated");
  assert.equal(s.mut(["set", s.job, "decision=APPROVE (human)"]).code, 0);
  assert.equal(s.mut(["set", s.job, "stage=pr-open"]).code, 2, "no pr");
  assert.equal(s.mut(["set", s.job, "stage=pr-open", pr]).code, 0);
});

test("globs: wildcard counts are capped and repeated ** collapse", () => {
  assert.equal(isGlob("src/**/*.ts"), true);
  assert.equal(isGlob("**/a/**/b"), true);
  assert.equal(isGlob("**/a/**/b/**/c"), false, "three ** segments");
  assert.equal(isGlob("**/**/**/**/**/**/**/x"), true, "collapses to one **");
  assert.equal(isGlob("a*b*c*d*e*f*g*h*i*j"), false, "more than 8 wildcards");
  assert.equal(isGlob("a**b/x"), false, "** inside a segment");
  assert.equal(globToRegExp("**/**/x").source, globToRegExp("**/x").source);
  assert.equal(matchGlob("**/**/x", "a/b/x"), true);
});

test("globs: worst allowed patterns stay fast on long paths", () => {
  const deep = `${Array.from({ length: 60 }, (_, i) => `d${i}`).join("/")}/nomatch`;
  const started = Date.now();
  for (const g of ["**/a*b*c*d/**/e*f*g*h", "**/*/*/*/*/*/*/*/x", "*?*?*?*?/**/y"]) {
    assert.equal(isGlob(g), true, g);
    assert.equal(matchGlob(g, deep), false);
  }
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});
