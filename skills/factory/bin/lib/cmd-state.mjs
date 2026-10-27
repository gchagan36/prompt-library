// State-editing commands: set, note, pkg, lens, round, chip, feedback, signoff, signoff-check.
import { readFileSync } from "node:fs";
import { Fail } from "./errors.mjs";
import { jobRelative, resolveJobFile } from "./jobfiles.mjs";
import { mutate, mutateIfChanged, openJob, splitAuth } from "./jobs.mjs";
import { isSecretLine } from "./secrets.mjs";
import { parseJson, readStateText, sha256 } from "./store.mjs";
import { NOTE_UNSAFE, PATTERNS, PKG_STATUSES, check, isProse } from "./validate.mjs";

const NOTE_MAX = 160;

const nullOr = (fn) => (raw) => (raw === "null" ? null : fn(raw));
const asIs = (raw) => raw;

// Token fields `set` may change. Values are validated with the whole state afterwards.
const SETTERS = Object.freeze({
  stage: asIs,
  target: asIs,
  branch: nullOr(asIs),
  worktree: nullOr(asIs),
  base: nullOr(asIs),
  head: nullOr(asIs),
  signoff: nullOr(asIs),
  decision: nullOr(asIs),
  pr: nullOr(asIs),
  linked: (raw) => {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    throw new Fail(2, "invalid linked");
  },
  rework: (raw) => {
    if (!/^[0-9]{1,2}$/.test(raw)) throw new Fail(2, "invalid rework");
    return Number(raw);
  }
});

const parsePair = (pair) => {
  const eq = typeof pair === "string" ? pair.indexOf("=") : -1;
  const key = eq > 0 ? pair.slice(0, eq) : "";
  if (!Object.hasOwn(SETTERS, key)) throw new Fail(2, `cannot set ${key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`);
  return [key, SETTERS[key](pair.slice(eq + 1))];
};

// Defence in depth for the two transitions that lead to a PR: the helper itself refuses
// them unless the paper trail supports them, whatever the caller's prose says.
function gateTransitions(next, prev, dir) {
  if (next.decision === "APPROVE" && prev.decision !== "APPROVE") {
    const last = next.rounds.at(-1);
    const allPass = last !== undefined && next.lenses.every((l) => last[l] === "PASS");
    if (!allPass) throw new Fail(2, "decision=APPROVE needs every lens PASS in the last round");
    if (next.signoff === null || next.signoff !== specHash(dir)) throw new Fail(2, "decision=APPROVE needs a valid sign-off");
  }
  if (next.stage === "pr-open" && prev.stage !== "pr-open") {
    if (next.decision !== "APPROVE" && next.decision !== "APPROVE (human)") throw new Fail(2, "stage=pr-open needs an approval");
    if (next.pr === null) throw new Fail(2, "stage=pr-open needs pr");
  }
}

export function cmdSet(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length < 2) throw new Fail(2, "usage: set <job> k=v ... --lease <token> --expect <hash>");
  const [ref, ...pairs] = auth.rest;
  const changes = Object.fromEntries(pairs.map(parsePair));
  mutate(ctx, ref, auth, (state, job) => {
    const next = { ...state, ...changes };
    gateTransitions(next, state, job.dir);
    return next;
  });
}

const checkNote = (text) => check(text, PATTERNS.note, "note");

function noteFromLine(dir, fileArg, nArg) {
  const name = jobRelative(dir, fileArg);
  const file = resolveJobFile(dir, name);
  if (file === null) throw new Fail(5, `missing ${name}`);
  if (!/^[1-9][0-9]{0,5}$/.test(nArg)) throw new Fail(2, "invalid line number");
  const line = readFileSync(file, "utf8").split(/\r?\n/)[Number(nArg) - 1] ?? "";
  if (isSecretLine(line)) return `possible secret in ${name}`;
  const clean = line.replace(NOTE_UNSAFE, "_").trim().slice(0, NOTE_MAX).trim();
  return clean.length > 0 ? clean : `line ${nArg} of ${name} is empty`;
}

export function cmdNote(ctx, args) {
  const auth = splitAuth(args);
  const [ref, mode, ...rest] = auth.rest;
  const forms = { "--text": 1, "--append": 1, "--line": 2 };
  if (!Object.hasOwn(forms, mode) || rest.length !== forms[mode]) {
    throw new Fail(2, "usage: note <job> --text <t> | --append <t> | --line <file> <n>");
  }
  mutate(ctx, ref, auth, (state, job) => {
    if (mode === "--text") return { ...state, note: checkNote(rest[0]) };
    if (mode === "--append") {
      const joined = `${state.note} ${checkNote(rest[0])}`;
      return { ...state, note: joined.length > NOTE_MAX ? joined.slice(-NOTE_MAX).trimStart() : joined };
    }
    return { ...state, note: noteFromLine(job.dir, rest[0], rest[1]) };
  });
}

export function cmdPkg(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 3) throw new Fail(2, "usage: pkg <job> <P> <status> --lease <token> --expect <hash>");
  const [ref, pkgArg, status] = auth.rest;
  const pkg = check(pkgArg, PATTERNS.pkgId, "package");
  if (!PKG_STATUSES.includes(status)) throw new Fail(2, "invalid status");
  mutate(ctx, ref, auth, (state) => {
    if (!state.packages.some((p) => p.id === pkg)) throw new Fail(2, `no package ${pkg}`);
    return { ...state, packages: state.packages.map((p) => (p.id === pkg ? { ...p, status } : p)) };
  });
}

export function cmdLens(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 2) throw new Fail(2, "usage: lens <job> <lens> --lease <token> --expect <hash>");
  const lens = check(auth.rest[1], PATTERNS.lens, "lens");
  mutateIfChanged(ctx, auth.rest[0], auth, (state) =>
    state.lenses.includes(lens) ? state : { ...state, lenses: [...state.lenses, lens] }
  );
}

export function cmdRound(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 1) throw new Fail(2, "usage: round <job> --lease <token> --expect <hash>");
  mutate(ctx, auth.rest[0], auth, (state) => {
    const r = state.round + 1;
    const chips = Object.fromEntries(state.lenses.map((l) => [l, "pending"]));
    return { ...state, rounds: [...state.rounds, chips], round: r, stage: "review", note: `round ${r}: reviewing` };
  });
}

// Exactly `VERDICT: PASS` on the first line is a pass. Anything else, a missing file, or a
// symlinked file, is CHANGES.
function verdictOf(dir, fileArg) {
  const name = jobRelative(dir, fileArg);
  let file;
  try {
    file = resolveJobFile(dir, name);
  } catch (err) {
    if (err.code === 3) return "CHANGES";
    throw err;
  }
  if (file === null) return "CHANGES";
  return readFileSync(file, "utf8").split(/\r?\n/)[0] === "VERDICT: PASS" ? "PASS" : "CHANGES";
}

const pendingNote = (r, chips) => {
  const pending = Object.keys(chips).filter((l) => chips[l] === "pending");
  return pending.length > 0 ? `round ${r}: waiting on ${pending.join(", ")}` : `round ${r}: all reviews in`;
};

export function cmdChip(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 3) throw new Fail(2, "usage: chip <job> <lens> <file> --lease <token> --expect <hash>");
  const [ref, lensArg, fileArg] = auth.rest;
  const lens = check(lensArg, PATTERNS.lens, "lens");
  mutate(ctx, ref, auth, (state, job) => {
    const latest = state.rounds.at(-1);
    if (!latest || !Object.hasOwn(latest, lens)) throw new Fail(2, `lens ${lens} is not in the latest round`);
    const chips = { ...latest, [lens]: verdictOf(job.dir, fileArg) };
    return { ...state, rounds: [...state.rounds.slice(0, -1), chips], note: pendingNote(state.round, chips) };
  });
}

export function cmdFeedback(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 2) throw new Fail(2, "usage: feedback <job> <file> --lease <token> --expect <hash>");
  let text;
  try {
    text = readFileSync(auth.rest[1], "utf8").replace(/\s+$/, "");
  } catch {
    throw new Fail(2, "cannot read feedback file");
  }
  if (!isProse(text)) throw new Fail(2, "invalid feedback");
  mutate(ctx, auth.rest[0], auth, (state) => ({
    ...state,
    feedback: [...state.feedback, text],
    rework: 0,
    decision: null,
    signoff: null
  }));
}

export function specHash(dir) {
  const file = resolveJobFile(dir, "spec.md");
  if (file === null) throw new Fail(5, "missing spec.md");
  return sha256(readFileSync(file, "utf8"));
}

export function cmdSignoff(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 1) throw new Fail(2, "usage: signoff <job> --lease <token> --expect <hash>");
  mutate(ctx, auth.rest[0], auth, (state, job) => ({ ...state, signoff: specHash(job.dir) }));
}

export function cmdSignoffCheck(ctx, args) {
  if (args.length !== 1) throw new Fail(2, "usage: signoff-check <job>");
  const job = openJob(ctx, args[0]);
  const state = parseJson(readStateText(job.dir).text, "state");
  if (state.signoff === null || state.signoff !== specHash(job.dir)) {
    throw new Fail(1, "sign-off does not match spec.md");
  }
}
