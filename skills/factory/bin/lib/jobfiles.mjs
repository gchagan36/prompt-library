// The agent-written markdown files in a job folder: a fixed whitelist, never a symlink,
// never outside the folder. Shared by factoryctl (note --line, chip) and the dashboard.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { Fail } from "./errors.mjs";

const NAME_RES = [
  /^(issue|spec|decision)\.md$/,
  /^build-P[1-9]\.md$/,
  /^round-[1-9][0-9]?\/review-[a-z0-9]+(-[a-z0-9]+){0,2}\.md$/,
  /^round-[1-9][0-9]?\/comments-scan\.md$/
];

export const isAllowedName = (name) => typeof name === "string" && NAME_RES.some((re) => re.test(name));

const isPlainFile = (file) => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};

const isPlainDir = (dir) => {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// Accepts a whitelisted name relative to the job folder, or an absolute path inside it.
export function jobRelative(dir, arg) {
  if (typeof arg !== "string" || arg.length === 0) throw new Fail(2, "invalid file");
  const rel = path.isAbsolute(arg) ? path.relative(dir, arg) : arg;
  const name = rel.split(path.sep).join("/");
  if (!isAllowedName(name)) throw new Fail(2, "invalid file");
  return name;
}

const isLinkEntry = (file) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

// The absolute path of a whitelisted job file, or null when it doesn't exist as a plain
// file. The whitelist admits no `..`, so the path can't leave the folder; a symlinked
// file or round folder is tampering (3).
export function resolveJobFile(dir, name) {
  if (!isAllowedName(name)) throw new Fail(2, "invalid file");
  const file = path.join(dir, ...name.split("/"));
  const parent = path.dirname(file);
  if ((parent !== dir && isLinkEntry(parent)) || isLinkEntry(file)) throw new Fail(3, `not a plain file: ${name}`);
  return isPlainFile(file) ? file : null;
}

const roundFiles = (dir, round) => {
  const roundDir = path.join(dir, round);
  if (!isPlainDir(roundDir)) return [];
  return readdirSync(roundDir)
    .map((f) => `${round}/${f}`)
    .filter((name) => isAllowedName(name) && isPlainFile(path.join(dir, name)));
};

const roundNumber = (name) => Number(name.slice("round-".length).split("/")[0]);

// Existing whitelisted files, in reading order: issue, spec, builds, rounds, decision.
export function listJobFiles(dir) {
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  const top = entries.filter((f) => isAllowedName(f) && isPlainFile(path.join(dir, f)));
  const rounds = entries.filter((f) => /^round-[1-9][0-9]?$/.test(f)).flatMap((r) => roundFiles(dir, r));
  const rank = (name) => {
    if (name === "issue.md") return [0, 0];
    if (name === "spec.md") return [1, 0];
    if (name.startsWith("build-")) return [2, Number(name.slice(7, 8))];
    if (name.startsWith("round-")) return [3, roundNumber(name)];
    return [4, 0];
  };
  const order = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || a.localeCompare(b);
  };
  return [...top, ...rounds].sort(order);
}
