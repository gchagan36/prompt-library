// Where factory state lives on disk. Everything hangs off FACTORY_HOME.
import { homedir } from "node:os";
import path from "node:path";

export const factoryHome = (env) =>
  path.resolve(env.FACTORY_HOME || path.join(homedir(), ".claude", "factory"));

export const reposDir = (home) => path.join(home, "repos");
export const repoDir = (home, repo) => path.join(reposDir(home), repo);
export const repoFile = (home, repo) => path.join(repoDir(home, repo), "repo.json");
export const jobsDir = (home, repo) => path.join(repoDir(home, repo), "jobs");
export const seqDir = (home, repo) => path.join(repoDir(home, repo), "seq");
export const jobDir = (home, repo, id) => path.join(jobsDir(home, repo), id);
export const worktreeDir = (home, repo, id) => path.join(repoDir(home, repo), "worktrees", id);
export const gapsFile = (home) => path.join(home, "gaps.jsonl");

export const STATE = "state.json";
export const PREV = "state.prev.json";
export const LEASE = "lease.json";
export const ROSTER = "roster.json";

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
