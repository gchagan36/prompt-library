// The single home of the secret patterns. Hits are reported by file:line, never by match.
import { existsSync, readFileSync } from "node:fs";
import { Fail } from "./errors.mjs";

const SECRET_RE = new RegExp(
  [
    "(?<![A-Za-z0-9])(ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{20,}",
    "(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}",
    "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}",
    "(?<![A-Za-z0-9])sk_(live|test)_[A-Za-z0-9]{16,}",
    "(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}",
    "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"
  ].join("|")
);

export const isSecretLine = (line) => SECRET_RE.test(line);

export const secretLines = (text) =>
  text.split(/\r?\n/).flatMap((line, i) => (isSecretLine(line) ? [i + 1] : []));

export function scanFiles(files) {
  if (files.length === 0) throw new Fail(2, "scan needs at least one file");
  return files.flatMap((file) => {
    if (!existsSync(file)) throw new Fail(2, `no such file: ${file}`);
    return secretLines(readFileSync(file, "utf8")).map((n) => `${file}:${n}`);
  });
}
