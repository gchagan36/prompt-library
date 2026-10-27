// Roster discovery: which factory builders and reviewers exist, read from agent frontmatter.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isGlob } from "./glob.mjs";
import { PATTERNS } from "./validate.mjs";

const BUILDER_RE = /^factory-builder(-[a-z0-9]+){0,3}$/;
const REVIEWER_RE = /^factory-review-([a-z0-9]+(-[a-z0-9]+){0,2})$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,60}$/;
const MAX_BYTES = 256 * 1024;

const unquote = (v) => {
  const t = v.trim();
  const quoted = t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0];
  return quoted ? t.slice(1, -1) : t;
};

// Top-level `key: value` pairs between the opening and closing `---`. Block scalars
// (`key: >` / `key: |`) are folded into one line; nested structures are ignored.
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const body = lines.slice(1, end);
  return body.reduce((acc, line, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!m || Object.hasOwn(acc, m[1])) return acc;
    const raw = m[2].trim();
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const rest = body.slice(i + 1);
      const stop = rest.findIndex((l) => !/^\s+/.test(l) && l.length > 0);
      const block = (stop < 0 ? rest : rest.slice(0, stop)).map((l) => l.trim()).filter(Boolean);
      return { ...acc, [m[1]]: block.join(" ") };
    }
    return { ...acc, [m[1]]: unquote(raw) };
  }, {});
}

const sentence = (description, label) => {
  const m = new RegExp(`${label}:\\s*(.+?)\\.(?=\\s|$)`).exec(description || "");
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

export const specialtiesOf = (description) =>
  [...new Set(sentence(description, "Specialties").filter((t) => PATTERNS.tag.test(t)))];

export const triggersOf = (description) => [...new Set(sentence(description, "Triggers").filter(isGlob))];

export function agentDirs(env, repoPath) {
  const project = path.resolve(repoPath, ".claude", "agents");
  const home = env.HOME || homedir();
  const dirs = env.FACTORY_AGENT_DIRS
    ? env.FACTORY_AGENT_DIRS.split(":").filter(Boolean).map((d) => path.resolve(d))
    : [project, path.join(home, ".claude", "agents")];
  return dirs.map((dir) => ({ dir, source: dir === project ? "project" : "global" }));
}

const isRegularFile = (file) => {
  try {
    const st = statSync(file);
    return st.isFile() && st.size <= MAX_BYTES;
  } catch {
    return false;
  }
};

const readAgents = ({ dir, source }) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f))
    .filter(isRegularFile)
    .map((file) => ({ ...parseFrontmatter(readFileSync(file, "utf8")), source }))
    .filter((fm) => typeof fm.name === "string");
};

const modelOf = (fm) => (typeof fm.model === "string" && MODEL_RE.test(fm.model) ? fm.model : null);
const byName = (a, b) => a.name.localeCompare(b.name);

export function discoverRoster(env, repoPath) {
  const seen = new Set();
  const agents = agentDirs(env, repoPath)
    .flatMap(readAgents)
    .filter((fm) => {
      if (seen.has(fm.name)) return false;
      seen.add(fm.name);
      return true;
    });
  const builders = agents
    .filter((fm) => BUILDER_RE.test(fm.name))
    .map((fm) => ({ name: fm.name, specialties: specialtiesOf(fm.description), model: modelOf(fm), source: fm.source }))
    .sort(byName);
  const reviewers = agents
    .filter((fm) => REVIEWER_RE.test(fm.name))
    .map((fm) => ({
      lens: REVIEWER_RE.exec(fm.name)[1],
      name: fm.name,
      triggers: triggersOf(fm.description),
      model: modelOf(fm),
      source: fm.source
    }))
    .sort(byName);
  return { builders, reviewers };
}
