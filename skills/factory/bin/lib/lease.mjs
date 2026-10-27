// Which session owns a job: the `claude` process the helper runs under (references/state.md).
import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { Fail } from "./errors.mjs";
import { LEASE, now } from "./paths.mjs";
import { atomicWrite, isSymlink, parseJson, readGuarded, serialize, sha256 } from "./store.mjs";

const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
const MAX_DEPTH = 64;
const LOCK_STALE_MS = 60_000;

// { ppid, lstart, comm } for one pid, or null if it doesn't exist.
export function psInfo(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const out = execFileSync("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      env: PS_ENV,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const parts = out.split(/\s+/);
    if (parts.length < 7) return null;
    return { ppid: Number(parts[0]), lstart: parts.slice(1, 6).join(" "), comm: parts.slice(6).join(" ") };
  } catch {
    return null;
  }
}

// Walk up from our parent to the first ancestor whose comm is `claude` (or FACTORY_OWNER_COMM).
export function findOwner(env, startPid = process.ppid) {
  const target = env.FACTORY_OWNER_COMM || "claude";
  let pid = startPid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth += 1) {
    const info = psInfo(pid);
    if (!info) break;
    if (path.basename(info.comm) === target) return { pid, pstart: info.lstart };
    pid = info.ppid;
  }
  return { pid: null, pstart: null };
}

const ttlMs = (env) => {
  const minutes = Number(env.FACTORY_LEASE_TTL_MIN);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 240) * 60_000;
};

// "live" | "free" | "released"
export function leaseStatus(lease, env) {
  if (!lease) return "free";
  if (lease.released) return "released";
  if (lease.host !== hostname()) return "free";
  if (lease.pid !== null && lease.pid !== undefined) {
    const info = psInfo(lease.pid);
    return info && info.lstart === lease.pstart ? "live" : "free";
  }
  const age = Date.now() - Date.parse(lease.claimed);
  return Number.isFinite(age) && age < ttlMs(env) ? "live" : "free";
}

export function readLease(dir) {
  const file = path.join(dir, LEASE);
  if (isSymlink(file)) throw new Fail(3, "symlink at lease.json");
  if (!existsSync(file)) return null;
  const lease = parseJson(readGuarded(file), "lease");
  if (lease === null || typeof lease !== "object" || Array.isArray(lease)) throw new Fail(3, "lease.json tampered");
  return lease;
}

export const writeLease = (dir, lease) => atomicWrite(path.join(dir, LEASE), serialize(lease));

// A fresh lease for this caller. Only the token's hash goes to disk; the token is printed once.
export function newLease(env, owner = findOwner(env)) {
  const token = randomBytes(16).toString("hex");
  const lease = {
    tokenHash: sha256(token),
    pid: owner.pid,
    pstart: owner.pstart,
    host: hostname(),
    claimed: now(),
    released: null
  };
  return { token, lease };
}

const sameHex = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function checkToken(lease, token) {
  if (!lease || lease.released || !sameHex(lease.tokenHash, sha256(token))) {
    throw new Fail(6, "lease token does not match, or the lease was released");
  }
}

export const isSameOwner = (lease, owner) =>
  owner.pid !== null && lease.pid === owner.pid && lease.pstart === owner.pstart;

// Serialises claims on one job with an exclusive lock directory.
export function withClaimLock(dir, fn) {
  const lock = path.join(dir, ".claim.lock");
  try {
    mkdirSync(lock);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) throw new Fail(6, "another claim is in progress");
    rmdirSync(lock);
    mkdirSync(lock);
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}
