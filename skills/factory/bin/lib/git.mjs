// git invocations: argument arrays only, never a shell.
import { execFileSync } from "node:child_process";
import { Fail } from "./errors.mjs";

export function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Fail(2, `git ${args[0]} failed`);
  }
}

// Untrimmed output with room for large diffs (execFileSync's default buffer is 1 MB).
export function gitRaw(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Fail(2, `git ${args[0]} failed`);
  }
}

export const gitLines = (cwd, args) => git(cwd, args).split("\n").filter((l) => l.length > 0);

export const diffNames = (cwd, from, to) =>
  gitLines(cwd, ["diff", "--name-only", "--no-renames", `${from}..${to}`]);
