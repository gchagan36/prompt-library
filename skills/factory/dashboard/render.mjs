// Minimal markdown for agent reports: headings, lists, fenced code, inline code, bold,
// tables. No links, images, or raw HTML. parseMarkdown returns a plain tree the page turns
// into DOM with textContent; renderHtml is the escaped-string form (tests, tooling).

const VERDICTS = Object.freeze({
  "VERDICT: PASS": "pass",
  "VERDICT: CHANGES": "changes",
  APPROVE: "approve",
  ESCALATE: "escalate"
});

export const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Inline tokens: [{ t: "text" | "code" | "bold", v }]
export function parseInline(text) {
  return text.split(/(`[^`]+`)/).flatMap((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return [{ t: "code", v: part.slice(1, -1) }];
    return part
      .split(/(\*\*[^*]+\*\*)/)
      .filter((p) => p.length > 0)
      .map((p) => (p.length > 4 && p.startsWith("**") && p.endsWith("**") ? { t: "bold", v: p.slice(2, -2) } : { t: "text", v: p }));
  });
}

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*([-*]|\d+\.)\s+(.*)$/;
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));
const startsBlock = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || (line.startsWith("|") && TABLE_SEP.test(next || ""));

function readFence(lines, i) {
  const end = lines.findIndex((l, j) => j > i && FENCE.test(l));
  const stop = end < 0 ? lines.length : end;
  return [{ type: "code", text: lines.slice(i + 1, stop).join("\n") }, stop + 1];
}

function readTable(lines, i) {
  let j = i + 2;
  while (j < lines.length && lines[j].trim().startsWith("|")) j += 1;
  return [{ type: "table", head: cells(lines[i]), rows: lines.slice(i + 2, j).map(cells) }, j];
}

function readList(lines, i) {
  const ordered = /^\s*\d+\./.test(lines[i]);
  let j = i;
  while (j < lines.length && LIST_ITEM.test(lines[j]) && /^\s*\d+\./.test(lines[j]) === ordered) j += 1;
  const items = lines.slice(i, j).map((l) => parseInline(LIST_ITEM.exec(l)[2]));
  return [{ type: "list", ordered, items }, j];
}

function readParagraph(lines, i) {
  let j = i;
  while (j < lines.length && lines[j].trim() !== "" && (j === i || !startsBlock(lines[j], lines[j + 1]))) j += 1;
  return [{ type: "p", inline: parseInline(lines.slice(i, j).map((l) => l.trim()).join(" ")) }, j];
}

function readBlock(lines, i) {
  const line = lines[i];
  if (FENCE.test(line)) return readFence(lines, i);
  const h = HEADING.exec(line);
  if (h) return [{ type: "heading", level: h[1].length, inline: parseInline(h[2]) }, i + 1];
  if (line.trim().startsWith("|") && TABLE_SEP.test(lines[i + 1] || "")) return readTable(lines, i);
  if (LIST_ITEM.test(line)) return readList(lines, i);
  return readParagraph(lines, i);
}

// { badge: "pass" | "changes" | "approve" | "escalate" | null, blocks: [...] }
export function parseMarkdown(md) {
  const lines = String(md).split(/\r?\n/);
  const badge = Object.hasOwn(VERDICTS, lines[0]) ? VERDICTS[lines[0]] : null;
  const body = badge ? lines.slice(1) : lines;
  const blocks = [];
  let i = 0;
  while (i < body.length) {
    if (body[i].trim() === "") {
      i += 1;
    } else {
      const [block, next] = readBlock(body, i);
      blocks.push(block);
      i = next;
    }
  }
  return { badge, badgeText: badge ? lines[0] : null, blocks };
}

const inlineHtml = (tokens) =>
  tokens
    .map(({ t, v }) => (t === "code" ? `<code>${escapeHtml(v)}</code>` : t === "bold" ? `<strong>${escapeHtml(v)}</strong>` : escapeHtml(v)))
    .join("");

const blockHtml = (b) => {
  if (b.type === "code") return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
  if (b.type === "heading") return `<h${b.level}>${inlineHtml(b.inline)}</h${b.level}>`;
  if (b.type === "list") {
    const tag = b.ordered ? "ol" : "ul";
    return `<${tag}>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join("")}</${tag}>`;
  }
  if (b.type === "table") {
    const row = (cs, tag) => `<tr>${cs.map((c) => `<${tag}>${inlineHtml(c)}</${tag}>`).join("")}</tr>`;
    return `<table><thead>${row(b.head, "th")}</thead><tbody>${b.rows.map((r) => row(r, "td")).join("")}</tbody></table>`;
  }
  return `<p>${inlineHtml(b.inline)}</p>`;
};

export function renderHtml(md) {
  const { badge, badgeText, blocks } = parseMarkdown(md);
  const head = badge ? `<span class="badge badge-${badge}">${escapeHtml(badgeText)}</span>` : "";
  return head + blocks.map(blockHtml).join("");
}
