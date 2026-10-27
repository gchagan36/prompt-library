import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { agentDirs, parseFrontmatter } from "../bin/lib/agents.mjs";
import { globToRegExp, isGlob, isRepoPath, matchGlob } from "../bin/lib/glob.mjs";
import { extractPlanBlock } from "../bin/lib/plan.mjs";
import { needsSecurity, triggeredLenses } from "../bin/lib/routing.mjs";
import { commitFiles, ctl, git, setup, tempDir } from "./helpers.mjs";

const agent = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody.\n`;

function agentDirsFixture() {
  const [first, second] = [tempDir("agents-a-"), tempDir("agents-b-")];
  const put = (dir, file, text) => writeFileSync(path.join(dir, file), text);
  put(first, "factory-builder.md", agent("factory-builder", "Generic builder. Specialties: any.", "model: sonnet\n"));
  put(first, "ts.md", agent("factory-builder-typescript", '"Builds TS. Specialties: typescript, node, Bad Tag, react."', "model: opus\n"));
  put(first, "code.md", agent("factory-review-code", "Code lens."));
  put(first, "security.md", agent("factory-review-security", "Security lens."));
  put(first, "ui.md", agent("factory-review-ui", "UI lens."));
  put(second, "ts-dup.md", agent("factory-builder-typescript", "Duplicate. Specialties: python."));
  put(second, "a11y.md", `---\nname: factory-review-a11y\ndescription: >\n  Accessibility lens.\n  Triggers: *.tsx, src/ui/**, ../bad.\nmodel: sonnet\n---\n`);
  put(second, "other.md", agent("code-reviewer", "Not a factory agent. Specialties: everything."));
  put(second, "nofm.md", "no frontmatter here\n");
  put(second, "notes.txt", agent("factory-builder-txt", "Not markdown."));
  symlinkSync("/dev/null", path.join(second, "devnull.md"));
  return `${first}:${second}`;
}

const plan = (overrides = {}) => ({
  packages: [
    { id: "P1", title: "Api", tags: ["typescript", "node"], agent: "factory-builder-typescript", gap: null, owns: ["lib/**"], depends: [], hotspots: ["package.json"] },
    { id: "P2", title: "Screen", tags: ["react-ui"], agent: "factory-builder", gap: "react-ui", owns: ["web/**"], depends: ["P1"], hotspots: ["package.json"] }
  ],
  lenses: ["code", "security"],
  ...overrides
});

const specWith = (body) => `# Spec\n## Summary\nx\n## Plan\n\n\`\`\`json\n${body}\n\`\`\`\n## Risks\nnone\n`;

function routed(opts = {}) {
  const s = setup({
    env: { FACTORY_AGENT_DIRS: agentDirsFixture() },
    files: { "lib/a.ts": "a", "lib/b.ts": "b", "web/x.tsx": "x", "package.json": "{}", "README.md": "r" },
    ...opts
  });
  assert.equal(ctl(s.env, ["roster", s.job, s.repoPath]).code, 0);
  s.writeSpec = (text) => writeFileSync(path.join(s.dir, "spec.md"), text);
  return s;
}

// Signs off the spec, then gives the job a worktree on factory/<id> at the pinned path.
function withWorktree(s) {
  const wt = path.join(s.home, "repos", s.repo, "worktrees", s.id);
  git(s.repoPath, ["worktree", "add", "-q", "-b", `factory/${s.id}`, wt, "HEAD"]);
  const base = git(wt, ["rev-parse", "HEAD"]);
  assert.equal(s.mut(["signoff", s.job]).code, 0);
  assert.equal(s.mut(["set", s.job, `worktree=${wt}`, `base=${base}`, `head=${base}`, `branch=factory/${s.id}`, "stage=build"]).code, 0);
  return { wt, base };
}

test("glob: anchored vs floating, **, *, ?", () => {
  assert.ok(matchGlob("lib/**", "lib/a/b.ts"));
  assert.ok(!matchGlob("lib/**", "src/lib/a.ts"));
  assert.ok(matchGlob("lib/**/x.ts", "lib/x.ts"));
  assert.ok(matchGlob("lib/**/x.ts", "lib/a/b/x.ts"));
  assert.ok(matchGlob("**/cli.*", "cli.js"));
  assert.ok(matchGlob("**/cli.*", "a/b/cli.ts"));
  assert.ok(matchGlob("src/?.ts", "src/a.ts"));
  assert.ok(!matchGlob("src/?.ts", "src/ab.ts"));
  assert.ok(!matchGlob("*.md", "docs/a.md"), "anchored: no slash means top level");
  assert.ok(matchGlob("*.md", "docs/a.md", { floating: true }), "floating: basename anywhere");
  assert.ok(!matchGlob("a+b.ts", "aab.ts"), "regex metacharacters are literal");
  assert.ok(globToRegExp("x/**").test("x/a/b") && !globToRegExp("x/**").test("y/x/a"));
  ["lib/**", "a/*.ts", "x?.md"].forEach((g) => assert.ok(isGlob(g), g));
  ["/abs/**", "../x", "a/../b", "a//b", "a\\b", "[ab].ts", "{a,b}", "", 5].forEach((g) => assert.ok(!isGlob(g), String(g)));
  assert.ok(isRepoPath("package.json"));
  assert.ok(!isRepoPath("lib/*.ts"));
});

test("frontmatter parsing handles quotes, block scalars and missing fences", () => {
  assert.deepEqual(parseFrontmatter("---\nname: x\ndescription: 'a: b'\n---\n"), { name: "x", description: "a: b" });
  assert.deepEqual(parseFrontmatter("---\ndescription: |\n  one\n  two\nname: y\n---\n"), { description: "one two", name: "y" });
  assert.deepEqual(parseFrontmatter("name: x\n"), {});
  assert.deepEqual(parseFrontmatter("---\nname: x\n"), {});
  assert.equal(agentDirs({ HOME: "/h" }, "/r")[1].dir, "/h/.claude/agents");
  assert.equal(agentDirs({ HOME: "/h" }, "/r")[0].source, "project");
});

test("roster: first dir wins on a name clash; specialties and triggers parsed; others ignored", () => {
  const s = routed();
  const roster = JSON.parse(readFileSync(path.join(s.dir, "roster.json"), "utf8"));
  assert.deepEqual(roster.builders.map((b) => b.name), ["factory-builder", "factory-builder-typescript"]);
  const ts = roster.builders[1];
  assert.deepEqual(ts.specialties, ["typescript", "node", "react"]);
  assert.equal(ts.model, "opus");
  assert.equal(ts.source, "global");
  assert.deepEqual(roster.builders[0].specialties, ["any"]);
  assert.deepEqual(roster.reviewers.map((r) => r.lens), ["a11y", "code", "security", "ui"]);
  assert.deepEqual(roster.reviewers[0].triggers, ["*.tsx", "src/ui/**"]);
  assert.equal(ctl(s.env, ["roster", s.job]).code, 2);
  assert.equal(ctl(s.env, ["roster", s.job, "/no/such/dir"]).code, 2);
});

test("roster marks agents in <repo>/.claude/agents as project", () => {
  const s = setup();
  const dir = path.join(s.repoPath, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "b.md"), agent("factory-builder-go", "Go. Specialties: go."));
  const env = { ...s.env, HOME: tempDir() };
  assert.equal(ctl(env, ["roster", s.job, s.repoPath]).code, 0);
  const roster = JSON.parse(readFileSync(path.join(s.dir, "roster.json"), "utf8"));
  assert.deepEqual(roster.builders, [{ name: "factory-builder-go", specialties: ["go"], model: null, source: "project" }]);
});

test("plan sets packages and lenses from the spec's plan block", () => {
  const s = routed();
  s.writeSpec(specWith(JSON.stringify(plan(), null, 2)));
  const res = s.mut(["plan", s.job]);
  assert.equal(res.code, 0, res.err);
  const st = JSON.parse(readFileSync(path.join(s.dir, "state.json"), "utf8"));
  assert.deepEqual(st.packages.map((p) => [p.id, p.agent, p.gap, p.status]), [
    ["P1", "factory-builder-typescript", null, "pending"],
    ["P2", "factory-builder", "react-ui", "pending"]
  ]);
  assert.deepEqual(st.lenses, ["code", "security"]);
});

test("plan rejects malformed, inconsistent or unroutable plans", () => {
  const s = routed();
  const p = plan();
  const pk = (i, patch) => ({ ...p, packages: p.packages.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const cases = [
    ["missing block", "# Spec\n## Plan\nno block\n"],
    ["no plan section", "# Spec\n"],
    ["two plan sections", `${specWith(JSON.stringify(p))}\n## Plan\n\`\`\`json\n{}\n\`\`\`\n`],
    ["two blocks", specWith(`${JSON.stringify(p)}\n\`\`\`\n\`\`\`json\n{}`)],
    ["text before block", "# S\n## Plan\nintro\n```json\n{}\n```\n"],
    ["unterminated", "# S\n## Plan\n```json\n{}\n"],
    ["bad json", specWith("{ nope")],
    ["extra key", specWith(JSON.stringify({ ...p, extra: 1 }))],
    ["no packages", specWith(JSON.stringify({ ...p, packages: [] }))],
    ["bad tag", specWith(JSON.stringify(pk(0, { tags: ["Bad Tag"] })))],
    ["dotdot glob", specWith(JSON.stringify(pk(0, { owns: ["lib/../secret/**"] })))],
    ["absolute glob", specWith(JSON.stringify(pk(0, { owns: ["/etc/**"] })))],
    ["glob hotspot", specWith(JSON.stringify(pk(0, { hotspots: ["*.json"] })))],
    ["depends on later", specWith(JSON.stringify(pk(0, { depends: ["P2"] })))],
    ["ids out of order", specWith(JSON.stringify(pk(1, { id: "P1" })))],
    ["gap with specialist", specWith(JSON.stringify(pk(0, { gap: "x" })))],
    ["generic without gap", specWith(JSON.stringify(pk(1, { gap: null })))],
    ["unknown agent", specWith(JSON.stringify(pk(0, { agent: "factory-builder-rust" })))],
    ["missing package key", specWith(JSON.stringify({ ...p, packages: [{ id: "P1" }] }))],
    ["lens without code", specWith(JSON.stringify({ ...p, lenses: ["security"] }))],
    ["unknown lens", specWith(JSON.stringify({ ...p, lenses: ["code", "perf"] }))],
    ["overlapping owns", specWith(JSON.stringify(pk(1, { owns: ["lib/a.ts"] })))]
  ];
  cases.forEach(([name, spec]) => {
    s.writeSpec(spec);
    const res = s.mut(["plan", s.job]);
    assert.equal(res.code, 2, `${name}: ${res.err}`);
    assert.match(res.err, /invalid plan/, name);
  });
  s.writeSpec(specWith(JSON.stringify(pk(1, { owns: ["lib/new-only/**"] }))));
  assert.equal(s.mut(["plan", s.job]).code, 0, "overlap only counts files that exist");
});

test("plan needs a spec and a roster, and only runs in spec or signoff", () => {
  const s = setup();
  assert.equal(s.mut(["plan", s.job]).code, 5, "no spec");
  writeFileSync(path.join(s.dir, "spec.md"), specWith(JSON.stringify(plan())));
  assert.equal(s.mut(["plan", s.job]).code, 5, "no roster");
  const r = routed();
  r.writeSpec(specWith(JSON.stringify(plan())));
  r.mut(["set", r.job, "stage=build"]);
  assert.equal(r.mut(["plan", r.job]).code, 2);
  assert.equal(r.mut(["plan"]).code, 2);
  assert.throws(() => extractPlanBlock("## Plan\n"), /exactly one json block/);
});

test("ownership flags files outside the package, allows hotspots, needs a signed-off spec", () => {
  const s = routed();
  s.writeSpec(specWith(JSON.stringify(plan())));
  assert.equal(s.mut(["plan", s.job]).code, 0);
  const sha = "a".repeat(40);
  assert.equal(ctl(s.env, ["ownership", s.job, "P1", sha, sha]).code, 2, "not signed off");
  const { wt, base } = withWorktree(s);
  const head = commitFiles(wt, { "lib/c.ts": "c", "package.json": "{\"x\":1}", "web/x.tsx": "changed", "README.md": "new" });
  const res = ctl(s.env, ["ownership", s.job, "P1", base, head]);
  assert.equal(res.code, 1);
  assert.deepEqual(res.out.sort(), ["README.md", "web/x.tsx"]);
  const clean = commitFiles(wt, { "lib/d.ts": "d" });
  assert.deepEqual(ctl(s.env, ["ownership", s.job, "P1", head, clean]).out.filter(Boolean), []);
  assert.equal(ctl(s.env, ["ownership", s.job, "P1", head, clean]).code, 0);
  assert.equal(ctl(s.env, ["ownership", s.job, "P7", head, clean]).code, 2);
  assert.equal(ctl(s.env, ["ownership", s.job, "P1", "HEAD", clean]).code, 2);
  assert.equal(ctl(s.env, ["ownership", s.job, "P1"]).code, 2);
  s.writeSpec(specWith(JSON.stringify(plan({ lenses: ["code"] }))));
  assert.equal(ctl(s.env, ["ownership", s.job, "P1", head, clean]).code, 3, "spec changed after sign-off");
});

test("ownership needs a worktree", () => {
  const s = routed();
  s.writeSpec(specWith(JSON.stringify(plan())));
  s.mut(["plan", s.job]);
  s.mut(["signoff", s.job]);
  const sha = "a".repeat(40);
  assert.equal(ctl(s.env, ["ownership", s.job, "P1", sha, sha]).code, 5);
});

test("diff triggers: docs/tests/styles skip security; ui and ux by path; custom globs", () => {
  assert.equal(needsSecurity(["README.md", "docs/a.md", "tests/a.test.ts", "a.css", "pkg/x_test.go"]), false);
  assert.equal(needsSecurity(["README.md", "lib/a.ts"]), true);
  assert.equal(needsSecurity([]), false);
  const custom = [{ lens: "a11y", triggers: ["*.tsx"] }, { lens: "perf", triggers: [] }];
  assert.deepEqual(triggeredLenses(["docs/guide.md"], custom), ["ux"]);
  assert.deepEqual(triggeredLenses(["src/components/Button.ts"], custom), ["security", "ui", "ux"]);
  assert.deepEqual(triggeredLenses(["web/x.tsx"], custom), ["security", "ui", "ux", "a11y"]);
  assert.deepEqual(triggeredLenses(["api/openapi.yaml", "bin/run"], []), ["security", "ux"]);
  assert.deepEqual(triggeredLenses(["tests/notes.md"], []), []);
  assert.deepEqual(triggeredLenses(["lib/x.ts"], []), ["security"]);
});

test("lenses adds triggered reviewers, reports missing ones, never removes", () => {
  const s = routed();
  s.writeSpec(specWith(JSON.stringify(plan({ lenses: ["code", "security"] }))));
  s.mut(["plan", s.job]);
  const { wt } = withWorktree(s);
  assert.equal(s.mut(["lenses", s.job]).out.length, 1, "empty diff: hash only");
  const head = commitFiles(wt, { "web/y.tsx": "y", "src/ui/panel.ts": "p" });
  s.mut(["set", s.job, `head=${head}`]);
  const res = s.mut(["lenses", s.job]);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(res.out.slice(0, -1).sort(), ["added a11y", "added ui", "missing ux"]);
  const st = JSON.parse(readFileSync(path.join(s.dir, "state.json"), "utf8"));
  assert.deepEqual(st.lenses, ["code", "security", "ui", "a11y"]);
  assert.deepEqual(s.mut(["lenses", s.job]).out.slice(0, -1), ["missing ux"]);
});

test("lenses needs worktree, base and head", () => {
  const s = routed();
  assert.equal(s.mut(["lenses", s.job]).code, 2);
  assert.equal(s.mut(["lenses"]).code, 2);
});
