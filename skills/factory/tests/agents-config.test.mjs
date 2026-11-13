// Guards the contracts between SKILL.md, the references, and the factory agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.resolve(SKILL_DIR, "../../agents");
const read = (file) => readFileSync(file, "utf8");

const frontmatter = (text) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "missing frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
  );
};

const agents = readdirSync(AGENTS_DIR)
  .filter((f) => /^factory-.*\.md$/.test(f))
  .map((f) => {
    const text = read(path.join(AGENTS_DIR, f));
    return { file: f, text, fm: frontmatter(text) };
  });
const builders = agents.filter((a) => a.fm.name.startsWith("factory-builder"));
const reviewers = agents.filter((a) => a.fm.name.startsWith("factory-review-"));
const tools = (a) => a.fm.tools.split(",").map((t) => t.trim());

test("core agents exist", () => {
  const names = agents.map((a) => a.fm.name);
  for (const core of ["factory-spec-writer", "factory-builder", "factory-review-code", "factory-approver"]) {
    assert.ok(names.includes(core), core);
  }
});

test("every agent: name matches file, model set, description says /factory only, has an untrusted-input guard", () => {
  for (const a of agents) {
    assert.equal(`${a.fm.name}.md`, a.file);
    assert.match(a.fm.model, /^(opus|sonnet|haiku)$/, a.file);
    assert.match(a.fm.description, /Spawned by \/factory only/, a.file);
    assert.match(a.text, /## Untrusted input/, a.file);
    assert.match(a.text, /\.env/, `${a.file} must forbid reading .env files`);
  }
});

test("builders: name pattern, Specialties sentence, edit tools, and the builder contract", () => {
  assert.ok(builders.length >= 1);
  for (const b of builders) {
    assert.match(b.fm.name, /^factory-builder(-[a-z0-9]+){0,3}$/);
    const spec = /Specialties: ([^.]+)\./.exec(b.fm.description);
    assert.ok(spec, `${b.file} needs "Specialties: …."`);
    for (const tag of spec[1].split(",").map((t) => t.trim())) {
      assert.match(tag, /^[a-z0-9]+(-[a-z0-9]+){0,2}$/, `${b.file}: ${tag}`);
    }
    for (const t of ["Read", "Edit", "Write", "Bash"]) assert.ok(tools(b).includes(t), `${b.file} lacks ${t}`);
    assert.match(b.text, /builder-contract\.md/);
  }
  assert.match(builders.find((b) => b.fm.name === "factory-builder").fm.description, /Specialties: any\./);
});

test("reviewers: lens pattern, no Edit tool, and the review contract", () => {
  assert.ok(reviewers.length >= 4);
  for (const r of reviewers) {
    assert.match(r.fm.name, /^factory-review-[a-z0-9]+(-[a-z0-9]+){0,2}$/);
    assert.ok(!tools(r).includes("Edit"), `${r.file} must not edit`);
    assert.match(r.text, /review-contract\.md/);
  }
});

test("spec writer and approver cannot edit code or (spec writer) run commands", () => {
  const spec = agents.find((a) => a.fm.name === "factory-spec-writer");
  const approver = agents.find((a) => a.fm.name === "factory-approver");
  assert.deepEqual(tools(spec).sort(), ["Glob", "Grep", "Read", "Write"]);
  assert.ok(!tools(approver).includes("Edit"));
  assert.match(spec.text, /## Plan\n```json/);
  assert.match(approver.text, /ROTATE:/);
});

test("verdict formats are exact", () => {
  const review = read(path.join(SKILL_DIR, "references/review-contract.md"));
  assert.match(review, /^VERDICT: PASS {2,}← or VERDICT: CHANGES/m);
  const approver = agents.find((a) => a.fm.name === "factory-approver").text;
  assert.match(approver, /^APPROVE {2,}← or ESCALATE/m);
});

test("SKILL.md: frontmatter, size, spawn prompts carry contract paths, referenced files exist", () => {
  const skill = read(path.join(SKILL_DIR, "SKILL.md"));
  const fm = frontmatter(skill);
  assert.equal(fm.name, "factory");
  assert.equal(fm["disable-model-invocation"], "true");
  assert.ok(skill.split("\n").length < 800);
  assert.match(skill, /Contract <skill>\/references\/builder-contract\.md/);
  assert.match(skill, /Contract <skill>\/references\/review-contract\.md/);
  assert.match(skill, /Routing <skill>\/references\/routing\.md/);
  assert.doesNotMatch(skill, /gh pr merge/);
  const refs = new Set([...skill.matchAll(/references\/([a-z-]+\.md)/g)].map((m) => m[1]));
  for (const ref of refs) assert.ok(existsSync(path.join(SKILL_DIR, "references", ref)), ref);
});

test("docs: the lens exists, comment rules reach builders, and docs impact flows spec → build → approver", () => {
  const docs = reviewers.find((r) => r.fm.name === "factory-review-docs");
  assert.ok(docs, "factory-review-docs missing");
  for (const rule of [/only a local copy of the repo/, /Tracker or review references/, /History narration/, /restate the code/]) {
    assert.match(docs.text, rule);
  }
  const contract = read(path.join(SKILL_DIR, "references/builder-contract.md"));
  assert.match(contract, /only a local copy of the repo/);
  assert.match(contract, /say why, not what/);
  assert.match(contract, /^## Docs {2,}/m);
  assert.match(agents.find((a) => a.fm.name === "factory-spec-writer").text, /^## Docs impact /m);
  const approver = agents.find((a) => a.fm.name === "factory-approver").text;
  assert.match(approver, /Docs delivered/);
  assert.match(approver, /checks 1–10/);
});

test("outside review: picked items are requirements for every agent, and the approver checks delivery", () => {
  const picked = /marks\s+(it\s+)?`fix`\s+or\s+`scope`/;
  for (const file of ["builder-contract.md", "review-contract.md"]) {
    assert.match(read(path.join(SKILL_DIR, "references", file)), picked, file);
  }
  for (const name of ["factory-spec-writer", "factory-approver"]) {
    assert.match(agents.find((a) => a.fm.name === name).text, picked, name);
  }
  assert.match(agents.find((a) => a.fm.name === "factory-approver").text, /Outside review delivered/);
  const skill = read(path.join(SKILL_DIR, "SKILL.md"));
  assert.match(skill, /^## \/factory address <id>$/m);
  assert.match(skill, /fctl pick '<job>' '<tmp>\/pick\.json'/);
  assert.doesNotMatch(read(path.join(SKILL_DIR, "references/github.md")), /resolveReviewThread/, "the factory never resolves threads");
});

test("every factory file stays under 800 lines", () => {
  const files = [
    ...agents.map((a) => path.join(AGENTS_DIR, a.file)),
    ...readdirSync(path.join(SKILL_DIR, "references")).map((f) => path.join(SKILL_DIR, "references", f))
  ];
  for (const f of files) assert.ok(read(f).split("\n").length <= 800, f);
});
