// Diff triggers: which review lenses a change requires (references/state.md "Diff triggers").
import { matchAny } from "./glob.mjs";

const F = { floating: true };
const DOCS = ["*.md", "*.mdx", "*.rst", "*.txt", "docs/**"];
const TESTS = ["test/**", "tests/**", "__tests__/**", "*.test.*", "*.spec.*", "test_*.py", "*_test.py", "*_test.go"];
const STYLES = ["*.css", "*.scss", "*.sass", "*.less"];
const UI_FILES = ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.html", ...STYLES];
const UI_SEGMENTS = ["components", "templates", "views", "pages", "layouts"];
const UX_FILES = ["README*", "docs/**", "*openapi*", "*.schema.json", "locales/**", "i18n/**", "bin/**", "cli/**", "**/cli.*"];

const isTest = (f) => matchAny(TESTS, f, F);
const isQuiet = (f) => matchAny(DOCS, f, F) || isTest(f) || matchAny(STYLES, f, F);
const dirSegments = (f) => f.split("/").slice(0, -1);

export const needsSecurity = (files) => files.length > 0 && !files.every(isQuiet);

export const isUi = (f) => matchAny(UI_FILES, f, F) || dirSegments(f).some((s) => UI_SEGMENTS.includes(s));

export const isUx = (f) => isUi(f) || matchAny(UX_FILES, f, F) || (matchAny(["*.md"], f, F) && !isTest(f));

// Every lens the diff triggers, built-in and custom (custom = a reviewer's Triggers globs).
export function triggeredLenses(files, reviewers) {
  const builtIn = [
    ["security", needsSecurity(files)],
    ["ui", files.some(isUi)],
    ["ux", files.some(isUx)]
  ];
  const custom = reviewers
    .filter((r) => r.triggers.length > 0)
    .map((r) => [r.lens, files.some((f) => matchAny(r.triggers, f, F))]);
  return [...new Set([...builtIn, ...custom].filter(([, hit]) => hit).map(([lens]) => lens))];
}

// Split triggered lenses not yet on the job into those with a reviewer (added) and those
// without one (missing: a reviewer gap). Never removes anything.
export function lensChanges(current, triggered, reviewers) {
  const available = new Set(reviewers.map((r) => r.lens));
  const fresh = triggered.filter((l) => !current.includes(l));
  return { added: fresh.filter((l) => available.has(l)), missing: fresh.filter((l) => !available.has(l)) };
}
