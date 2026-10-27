// Factory dashboard: polls the local API every 2s and renders with DOM APIs only.
import { parseMarkdown } from "./render.mjs";

const POLL_MS = 2000;
const FILTER_KEY = "factory.repo";
const PR_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/;
const COLUMNS = [
  ["spec", "Spec", ["spec"]],
  ["signoff", "Sign-off", ["signoff"]],
  ["build", "Build", ["build"]],
  ["review", "Review", ["review"]],
  ["approve", "Approve", ["approve"]],
  ["needs-human", "Needs human", ["needs-human"]],
  ["pr-open", "PR open", ["pr-open"]],
  ["done", "Done", ["merged", "closed"]]
];
const ATTENTION = new Set(["signoff", "needs-human"]);

const $ = (id) => document.getElementById(id);
const view = { jobs: [], gaps: [], jobsKey: "", gapsKey: "", open: null, docKey: "", filesKey: "" };

const store = {
  get() {
    try {
      return window.localStorage.getItem(FILTER_KEY) || "";
    } catch {
      return "";
    }
  },
  set(value) {
    try {
      window.localStorage.setItem(FILTER_KEY, value);
    } catch {
      // storage unavailable: the filter just isn't remembered
    }
  }
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "text") node.textContent = v;
    else if (k === "className") node.className = v;
    else node.setAttribute(k, v);
  });
  children.filter(Boolean).forEach((c) => node.append(c));
  return node;
}

const getJson = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};

const getText = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  return res.ok ? res.text() : null;
};

const shortAgent = (agent) => (agent === "factory-builder" ? "generic" : agent.replace(/^factory-builder-/, ""));
const jobKey = (job) => `${job.repo}/${job.id}`;

function packageChips(job) {
  return (job.packages || []).map((p) => {
    const label = `${p.id} ${shortAgent(p.agent)}${p.gap ? ` ⚑ ${p.gap}` : ""}`;
    const title = `${p.title} (${p.status})${p.gap ? `; gap: no ${p.gap} specialist` : ""}`;
    return el("span", { className: `chip ${p.gap ? "gap" : p.status}`, title, text: label });
  });
}

function roundRows(job) {
  return (job.rounds || []).map((round, i) =>
    el("div", { className: "chips" }, [
      el("span", { className: "round-label", text: `R${i + 1}` }),
      ...Object.entries(round).map(([lens, chip]) => el("span", { className: `chip ${chip}`, title: `${lens}: ${chip}`, text: lens }))
    ])
  );
}

function leaseBadge(job) {
  if (job.orphan) return el("span", { className: "badge orphan", title: "Working stage with no live session. Resume it with /factory resume.", text: "ORPHANED" });
  if (job.lease === "live") return el("span", { className: "badge live", title: "A session is driving this job", text: "live" });
  return null;
}

function card(job) {
  const key = jobKey(job);
  const pr = typeof job.pr === "string" && PR_RE.test(job.pr)
    ? el("a", { href: job.pr, target: "_blank", rel: "noreferrer", "data-key": `pr:${key}`, text: `PR #${job.pr.split("/").pop()}` })
    : null;
  return el("div", { className: `card${job.orphan ? " orphan" : ""}` }, [
    el("p", { className: "card-title", text: job.title || job.id }),
    el("div", { className: "meta" }, [
      el("span", { text: job.id }),
      el("span", { text: job.repoName }),
      Number.isInteger(job.issue) ? el("span", { text: `#${job.issue}` }) : null
    ]),
    el("div", { className: "chips" }, packageChips(job)),
    ...roundRows(job),
    job.invalid ? el("p", { className: "note", text: job.invalid }) : null,
    job.note ? el("p", { className: "note", text: job.note }) : null,
    el("div", { className: "card-actions" }, [
      el("button", { type: "button", "data-key": `open:${key}`, "data-open": key, text: "Details" }),
      leaseBadge(job),
      pr
    ])
  ]);
}

const visibleJobs = () => {
  const repo = $("repo-filter").value;
  return view.jobs.filter((j) => !repo || j.repo === repo);
};

function renderBoard() {
  const board = $("board");
  const focusKey = document.activeElement?.dataset?.key;
  const scroll = Object.fromEntries([...board.querySelectorAll(".column")].map((c) => [c.dataset.col, c.scrollTop]));
  const jobs = visibleJobs();
  const columns = COLUMNS.map(([col, label, stages]) => {
    const inCol = jobs.filter((j) => stages.includes(j.stage) || (col === "needs-human" && !j.stage));
    return el("section", { className: `column${ATTENTION.has(col) ? " attention" : ""}`, "data-col": col, "aria-label": label }, [
      el("h2", {}, [el("span", { text: label }), el("span", { text: String(inCol.length) })]),
      ...(inCol.length ? inCol.map(card) : [el("p", { className: "empty", text: "Nothing here" })])
    ]);
  });
  board.replaceChildren(...columns);
  board.querySelectorAll(".column").forEach((c) => (c.scrollTop = scroll[c.dataset.col] || 0));
  if (focusKey) board.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

function renderRepoFilter() {
  const select = $("repo-filter");
  const repos = [...new Map(view.jobs.map((j) => [j.repo, j.repoName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const wanted = select.value || store.get();
  select.replaceChildren(el("option", { value: "", text: "All repos" }), ...repos.map(([key, name]) => el("option", { value: key, text: name })));
  select.value = repos.some(([key]) => key === wanted) ? wanted : "";
}

function renderGaps() {
  $("gap-count").textContent = String(view.gaps.length);
  const rows = view.gaps.map((g) =>
    el("tr", {}, [
      el("td", { text: g.kind }),
      el("td", { text: g.specialty }),
      el("td", { text: String(g.count) }),
      el("td", { text: (g.repos || []).join(", ") })
    ])
  );
  $("gap-rows").replaceChildren(...(rows.length ? rows : [el("tr", {}, [el("td", { colspan: "4", className: "empty", text: "No gaps recorded" })])]));
}

function inlineNodes(tokens) {
  return tokens.map(({ t, v }) => (t === "code" ? el("code", { text: v }) : t === "bold" ? el("strong", { text: v }) : document.createTextNode(v)));
}

function blockNode(b) {
  if (b.type === "code") return el("pre", {}, [el("code", { text: b.text })]);
  if (b.type === "heading") return el(`h${Math.min(b.level + 2, 6)}`, {}, inlineNodes(b.inline));
  if (b.type === "list") return el(b.ordered ? "ol" : "ul", {}, b.items.map((it) => el("li", {}, inlineNodes(it))));
  if (b.type === "table") {
    const row = (cs, tag) => el("tr", {}, cs.map((c) => el(tag, {}, inlineNodes(c))));
    return el("table", {}, [el("thead", {}, [row(b.head, "th")]), el("tbody", {}, b.rows.map((r) => row(r, "td")))]);
  }
  return el("p", {}, inlineNodes(b.inline));
}

function renderDoc(text) {
  const doc = $("doc");
  if (text === null) return doc.replaceChildren(el("p", { className: "empty", text: "File not available" }));
  const { badge, badgeText, blocks } = parseMarkdown(text);
  doc.replaceChildren(...(badge ? [el("span", { className: `badge badge-${badge}`, text: badgeText })] : []), ...blocks.map(blockNode));
}

async function refreshDrawer() {
  if (!view.open) return;
  const { repo, id } = view.open;
  const job = view.jobs.find((j) => j.repo === repo && j.id === id);
  $("drawer-title").textContent = job ? `${job.title} (${job.id})` : id;
  $("drawer-feature").textContent = job?.feature || "";
  const q = `repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}`;
  const files = await getJson(`/api/files?${q}`);
  if (!view.open.file || !files.includes(view.open.file)) view.open = { ...view.open, file: files.at(-1) || null };
  const filesKey = JSON.stringify([files, view.open.file]);
  if (filesKey !== view.filesKey) {
    view.filesKey = filesKey;
    const nav = $("drawer-files");
    const focusKey = nav.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    nav.replaceChildren(
      ...files.map((f) => el("button", { type: "button", "data-file": f, "data-key": `file:${f}`, "aria-pressed": String(f === view.open.file), text: f }))
    );
    if (focusKey) nav.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
  if (!view.open.file) return renderDoc("No files yet.");
  const text = await getText(`/api/file?${q}&name=${encodeURIComponent(view.open.file)}`);
  const docKey = `${view.open.file}\u0000${text}`;
  if (docKey !== view.docKey) {
    view.docKey = docKey;
    renderDoc(text);
  }
}

function openDrawer(key) {
  const slash = key.indexOf("/");
  view.open = { repo: key.slice(0, slash), id: key.slice(slash + 1), file: null };
  view.filesKey = "";
  view.docKey = "";
  $("drawer").hidden = false;
  refreshDrawer().then(() => $("drawer-close").focus()).catch(showError);
}

function closeDrawer() {
  const key = view.open ? `open:${view.open.repo}/${view.open.id}` : null;
  view.open = null;
  $("drawer").hidden = true;
  if (key) $("board").querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

const showError = (err) => {
  $("status").textContent = `offline: ${err.message}`;
  $("status").className = "status error";
};

async function poll() {
  try {
    const [jobs, gaps] = await Promise.all([getJson("/api/jobs"), getJson("/api/gaps")]);
    const jobsKey = JSON.stringify(jobs);
    if (jobsKey !== view.jobsKey) {
      view.jobsKey = jobsKey;
      view.jobs = jobs;
      renderRepoFilter();
      renderBoard();
    }
    const gapsKey = JSON.stringify(gaps);
    if (gapsKey !== view.gapsKey) {
      view.gapsKey = gapsKey;
      view.gaps = gaps;
      renderGaps();
    }
    await refreshDrawer();
    $("status").textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"} · updated ${new Date().toLocaleTimeString()}`;
    $("status").className = "status";
  } catch (err) {
    showError(err);
  }
}

function wire() {
  $("repo-filter").addEventListener("change", (e) => {
    store.set(e.target.value);
    renderBoard();
  });
  $("board").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-open]");
    if (btn) openDrawer(btn.dataset.open);
  });
  $("drawer-files").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-file]");
    if (!btn || !view.open) return;
    view.open = { ...view.open, file: btn.dataset.file };
    refreshDrawer().catch(showError);
  });
  $("drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && view.open) closeDrawer();
  });
}

wire();
poll();
setInterval(poll, POLL_MS);
