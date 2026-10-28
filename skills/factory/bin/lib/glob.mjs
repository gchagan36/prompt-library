// Small, predictable glob matching: `**`, `*`, `?` only.
//   anchored: the pattern matches the whole repo-relative path (used for package `owns`).
//   floating: a pattern without `/` matches the basename at any depth, like .gitignore
//             (used for reviewer triggers, where matching more is the safe direction).
const GLOB_CHARS = /^[A-Za-z0-9._@+=,~*?/-]{1,200}$/;
const PATH_CHARS = /^[A-Za-z0-9._@+=,~/-]{1,200}$/;

const hasBadSegment = (p) => p.split("/").some((seg) => seg === "" || seg === "..");

// Wildcards are capped so the compiled regex can't backtrack catastrophically on long paths.
const MAX_DOUBLE_STARS = 2;
const MAX_WILDCARDS = 8;
const collapse = (p) => p.replace(/(^|\/)\*\*(?:\/\*\*)+(?=\/|$)/g, "$1**");

export const isGlob = (p) => {
  if (typeof p !== "string" || !GLOB_CHARS.test(p) || p.startsWith("/") || hasBadSegment(p)) return false;
  const segments = collapse(p).split("/");
  const doubles = segments.filter((seg) => seg === "**").length;
  const wildcards = (segments.filter((seg) => seg !== "**").join("/").match(/[*?]/g) || []).length;
  return doubles <= MAX_DOUBLE_STARS && wildcards <= MAX_WILDCARDS && segments.every((s) => s === "**" || !s.includes("**"));
};

export const isRepoPath = (p) =>
  typeof p === "string" && PATH_CHARS.test(p) && !p.startsWith("/") && !hasBadSegment(p);

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\=,~@]/g, "\\$&");

export function globToRegExp(glob) {
  const segments = collapse(glob).split("/");
  const parts = segments.map((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") return last ? ".*" : "(?:[^/]+/)*";
    const body = escapeRe(seg).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    return last ? body : `${body}/`;
  });
  return new RegExp(`^${parts.join("")}$`);
}

const cache = new Map();
const compiled = (glob) => {
  if (!cache.has(glob)) cache.set(glob, globToRegExp(glob));
  return cache.get(glob);
};

export function matchGlob(glob, file, { floating = false } = {}) {
  const target = floating && !glob.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : file;
  return compiled(glob).test(target);
}

export const matchAny = (globs, file, opts) => globs.some((g) => matchGlob(g, file, opts));
