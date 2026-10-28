// Hashing and atomic, symlink-refusing reads and writes of the factory's own files.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Fail } from "./errors.mjs";
import { PREV, STATE } from "./paths.mjs";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const isSymlink = (file) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

// Reads a file the factory owns. A symlink is tampering (3); a missing file is 5.
export function readGuarded(file, missingCode = 5) {
  if (isSymlink(file)) throw new Fail(3, `symlink at ${path.basename(file)}`);
  if (!existsSync(file)) throw new Fail(missingCode, `missing ${path.basename(file)}`);
  return readFileSync(file, "utf8");
}

// Exclusive random temp file in the same directory, then rename over the target.
// rename replaces a symlink rather than following it, and we refuse one up front anyway.
export function atomicWrite(file, text) {
  if (isSymlink(file)) throw new Fail(3, `symlink at ${path.basename(file)}`);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp already gone
    }
    throw err;
  }
}

export const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Fail(2, `invalid ${what} JSON`);
  }
};

// { text, hash } of state.json, refusing a symlink.
export function readStateText(dir) {
  const text = readGuarded(path.join(dir, STATE));
  return { text, hash: sha256(text) };
}

export function readState(dir) {
  const { text, hash } = readStateText(dir);
  return { state: parseJson(text, "state"), hash };
}

// Writes state.json and refreshes the restore backup with the same content.
export function writeState(dir, state) {
  const text = serialize(state);
  atomicWrite(path.join(dir, STATE), text);
  atomicWrite(path.join(dir, PREV), text);
  return sha256(text);
}

// Puts the backup back only if it is exactly the board the orchestrator last wrote.
export function restoreState(dir, hash) {
  const prev = path.join(dir, PREV);
  if (isSymlink(prev) || !existsSync(prev)) throw new Fail(4, "restore backup missing or tampered");
  const text = readFileSync(prev, "utf8");
  if (sha256(text) !== hash) throw new Fail(4, "restore backup tampered");
  atomicWrite(path.join(dir, STATE), text);
  return hash;
}
