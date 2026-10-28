// Outside review commands: outside, outside-count, pick, replies.
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Fail } from "./errors.mjs";
import { resolveJobFile } from "./jobfiles.mjs";
import { mutateIfChanged, openJob, splitAuth } from "./jobs.mjs";
import { collectItems, parsePicks, parseTrusted, renderPass } from "./outside.mjs";
import { atomicWrite, parseJson, readStateText } from "./store.mjs";
import { OUTSIDE_PASS_MAX, itemUrl } from "./validate.mjs";

const passFile = (k) => `outside-${k}.md`;

const readJsonFile = (file, what) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Fail(2, `cannot read ${what} file`);
  }
  return parseJson(text, what);
};

const readInputs = ([threads, reviews, comments, trusted]) => ({
  input: {
    threads: readJsonFile(threads, "threads"),
    reviews: readJsonFile(reviews, "reviews"),
    comments: readJsonFile(comments, "comments")
  },
  trusted: parseTrusted(readJsonFile(trusted, "trusted"))
});

// An unpicked latest pass is open: a new fetch replaces it.
const splitPasses = (state) => {
  const passes = state.outside ?? [];
  const open = passes.length > 0 && passes.at(-1).picks === null;
  return { kept: open ? passes.slice(0, -1) : passes, open };
};

const seenIds = (passes) => new Set(passes.flatMap((p) => p.items.map((it) => it.id)));

const FILES_USAGE = "<threads.json> <reviews.json> <comments.json> <trusted.json>";

// Writes outside-<k>.md and records pass k. Prints pass, items, untrusted, more, partial.
export function cmdOutside(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 5) throw new Fail(2, `usage: outside <job> ${FILES_USAGE} --lease <token> --expect <hash>`);
  const { input, trusted } = readInputs(auth.rest.slice(1));
  let render = null;
  let stale = null;
  mutateIfChanged(ctx, auth.rest[0], auth, (state) => {
    if (state.stage !== "pr-open" || state.pr === null) throw new Fail(2, "outside only in stage pr-open with a pr");
    const { kept, open } = splitPasses(state);
    const found = collectItems(input, trusted, seenIds(kept));
    const k = kept.length + 1;
    ctx.out(`pass ${found.items.length > 0 ? k : 0}`);
    ctx.out(`items ${found.items.length}`);
    ctx.out(`untrusted ${found.untrusted}`);
    ctx.out(`more ${found.more}`);
    ctx.out(`partial ${found.partial ? "yes" : "no"}`);
    if (found.items.length === 0) {
      stale = open ? k : null;
      return open ? { ...state, outside: kept } : state;
    }
    if (kept.length >= OUTSIDE_PASS_MAX) throw new Fail(2, "too many outside review passes");
    render = { k, text: renderPass(k, state.pr, found) };
    const items = found.items.map((it) => ({ id: it.id, reply: it.reply, url: itemUrl(state.pr, it.id) }));
    return { ...state, outside: [...kept, { items, picks: null, shipped: null }] };
  });
  // The state is written first: a crash before the file lands leaves an open pass that the
  // next fetch replaces.
  const dir = openJob(ctx, auth.rest[0]).dir;
  if (render !== null) atomicWrite(path.join(dir, passFile(render.k)), render.text);
  if (stale !== null) {
    const file = resolveJobFile(dir, passFile(stale));
    if (file !== null) unlinkSync(file);
  }
}

// Read-only: how many new trusted items a fetch would list. Sync uses it to report.
export function cmdOutsideCount(ctx, args) {
  if (args.length !== 5) throw new Fail(2, `usage: outside-count <job> ${FILES_USAGE}`);
  const job = openJob(ctx, args[0]);
  const { input, trusted } = readInputs(args.slice(1));
  const state = parseJson(readStateText(job.dir).text, "state");
  const found = collectItems(input, trusted, seenIds(splitPasses(state).kept));
  ctx.out(`items ${found.items.length + found.more}`);
  ctx.out(`untrusted ${found.untrusted}`);
}

export function cmdPick(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 2) throw new Fail(2, "usage: pick <job> <file> --lease <token> --expect <hash>");
  const raw = readJsonFile(auth.rest[1], "pick");
  mutateIfChanged(ctx, auth.rest[0], auth, (state) => {
    if (state.stage !== "pr-open") throw new Fail(2, "pick only in stage pr-open");
    const passes = state.outside ?? [];
    const last = passes.at(-1);
    if (last === undefined || last.picks !== null) throw new Fail(2, "no outside review pass waiting for picks");
    const picks = parsePicks(raw, last.items.length);
    return { ...state, outside: [...passes.slice(0, -1), { ...last, picks }] };
  });
}

// Marks the latest picked pass shipped at the current head, and prints what to answer on
// GitHub: `reply <comment id>` per thread, `link <url>` per review or PR comment. Prints
// nothing for a pass already shipped or with nothing picked to fix.
export function cmdReplies(ctx, args) {
  const auth = splitAuth(args);
  if (auth.rest.length !== 1) throw new Fail(2, "usage: replies <job> --lease <token> --expect <hash>");
  mutateIfChanged(ctx, auth.rest[0], auth, (state) => {
    const passes = state.outside ?? [];
    const last = passes.at(-1);
    if (last === undefined || last.picks === null || last.shipped !== null) return state;
    if (state.head === null) throw new Fail(2, "replies needs head");
    const done = last.items.filter((_, i) => last.picks[i] !== "skip");
    if (done.length === 0) return state;
    [...new Set(done.filter((it) => it.reply !== null).map((it) => it.reply))].forEach((id) => ctx.out(`reply ${id}`));
    done.filter((it) => it.reply === null).forEach((it) => ctx.out(`link ${it.url}`));
    return { ...state, outside: [...passes.slice(0, -1), { ...last, shipped: state.head }] };
  });
}
