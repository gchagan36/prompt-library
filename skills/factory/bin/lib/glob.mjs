// Small, predictable glob matching: `**`, `*`, `?` only.
//   anchored: the pattern matches the whole repo-relative path (used for package `owns`).
//   floating: a pattern without `/` matches the basename at any depth, like .gitignore
//             (used for reviewer triggers, where matching more is the safe direction).
const GLOB_CHARS = /^[A-Za-z0-9._@+=,~*?/-]{1,200}$/;
const PATH_CHARS = /^[A-Za-z0-9._@+=,~/-]{1,200}$/;

const hasBadSegment = (p) => p.split("/").some((seg) => seg === "" || seg === "..");

export const isGlob = (p) =>
  typeof p === "string" && GLOB_CHARS.test(p) && !p.startsWith("/") && !hasBadSegment(p);

export const isRepoPath = (p) =>
  typeof p === "string" && PATH_CHARS.test(p) && !p.startsWith("/") && !hasBadSegment(p);

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\=,~@]/g, "\\$&");

export function globToRegExp(glob) {
  const segments = glob.split("/");
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
