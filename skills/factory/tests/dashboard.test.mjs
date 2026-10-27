import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDashboardServer, listen } from "../bin/lib/server.mjs";
import { escapeHtml, parseInline, parseMarkdown, renderHtml } from "../dashboard/render.mjs";
import { BIN, DASHBOARD_DIR, ctl, setup, tempDir, writeJson } from "./helpers.mjs";

let server;
let port;
let fx;

// Two repos in one FACTORY_HOME: a live job with files, and an orphaned working job.
function fixture() {
  const a = setup();
  const b = setup({ env: {} });
  const env = { ...b.env, FACTORY_HOME: a.home };
  const repoB = ctl(env, ["repo"], b.repoPath).out[0];
  const created = ctl(env, ["create", repoB, writeJson(tempDir(), "j.json", { slug: "other", issue: 3, title: "Other", feature: "f", target: "main" })]);
  const dirB = path.join(a.home, "repos", repoB, "jobs", created.out[0]);
  const lease = JSON.parse(readFileSync(path.join(dirB, "lease.json"), "utf8"));
  writeFileSync(path.join(dirB, "lease.json"), JSON.stringify({ ...lease, pid: spawnSync("true").pid }));
  writeFileSync(path.join(a.dir, "spec.md"), "# Spec\n<script>alert(1)</script>\n");
  mkdirSync(path.join(a.dir, "round-1"));
  writeFileSync(path.join(a.dir, "round-1", "review-code.md"), "VERDICT: PASS\n");
  writeFileSync(path.join(a.dir, "build-P1.md"), "# Build\n");
  writeFileSync(path.join(a.dir, "notes.md"), "not whitelisted\n");
  symlinkSync("/etc/hostname", path.join(a.dir, "decision.md"));
  return { a, repoB, idB: created.out[0] };
}

const get = (urlPath, { host = `127.0.0.1:${port}`, method = "GET" } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });

before(async () => {
  fx = fixture();
  server = createDashboardServer({ env: fx.a.env, dashboardDir: DASHBOARD_DIR });
  port = await listen(server, 0);
});
after(() => server.close());

test("jobs aggregates every repo, flags orphans, and leaks no tokens or paths", async () => {
  const res = await get("/api/jobs");
  assert.equal(res.status, 200);
  const jobs = JSON.parse(res.body);
  assert.equal(jobs.length, 2);
  const live = jobs.find((j) => j.repo === fx.a.repo);
  const orphan = jobs.find((j) => j.repo === fx.repoB);
  assert.equal(live.lease, "live");
  assert.equal(live.orphan, false);
  assert.equal(live.repoName, "demo-repo");
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.issue, 3);
  assert.ok(!res.body.includes(fx.a.token));
  assert.ok(!res.body.includes("tokenHash"));
  assert.ok(!res.body.includes(fx.a.home), "no worktree or home paths");
});

test("security headers on every response", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-security-policy"], /default-src 'self'; frame-ancestors 'none'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  for (const p of ["/app.js", "/app.css", "/render.mjs", "/api/health"]) assert.equal((await get(p)).status, 200, p);
  assert.equal((await get("/state.json")).status, 404);
});

test("a foreign Host header is refused; only GET is allowed", async () => {
  assert.equal((await get("/api/jobs", { host: "evil.example:80" })).status, 403);
  assert.equal((await get("/api/jobs", { host: `127.0.0.1:${port + 1}` })).status, 403);
  assert.equal((await get("/api/jobs", { host: `localhost:${port}` })).status, 200);
  const post = await get("/api/jobs", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET");
});

test("files lists only whitelisted plain files; file serves their text", async () => {
  const q = `repo=${fx.a.repo}&id=${fx.a.id}`;
  const files = JSON.parse((await get(`/api/files?${q}`)).body);
  assert.deepEqual(files, ["spec.md", "build-P1.md", "round-1/review-code.md"]);
  const spec = await get(`/api/file?${q}&name=spec.md`);
  assert.equal(spec.status, 200);
  assert.match(spec.headers["content-type"], /^text\/plain/);
  assert.match(spec.body, /<script>/, "served as text/plain, rendered escaped by the page");
  assert.equal((await get(`/api/file?${q}&name=round-1%2Freview-code.md`)).body, "VERDICT: PASS\n");
  assert.equal((await get(`/api/file?${q}&name=issue.md`)).status, 404);
});

test("traversal and non-whitelisted names are rejected", async () => {
  const q = `repo=${fx.a.repo}&id=${fx.a.id}`;
  const names = ["../../../../etc/passwd", "%2e%2e%2fstate.json", "/etc/passwd", "state.json", "state.prev.json",
    "lease.json", "notes.md", "decision.md", "round-1/../spec.md", "spec.md%00.png"];
  for (const name of names) {
    const res = await get(`/api/file?${q}&name=${name}`);
    assert.ok([400, 404].includes(res.status), `${name} -> ${res.status}`);
    assert.ok(!res.body.includes("tokenHash") && !res.body.includes('"schema"'), name);
  }
  assert.equal((await get(`/api/file?repo=..&id=${fx.a.id}&name=spec.md`)).status, 400);
  assert.equal((await get(`/api/file?repo=${fx.a.repo}&id=../x&name=spec.md`)).status, 400);
  assert.equal((await get(`/api/files?repo=${fx.a.repo}`)).status, 400);
  assert.equal((await get("/api/file")).status, 400);
});

test("a symlinked round folder is not listed or served", async () => {
  const s = setup();
  const outside = tempDir();
  writeFileSync(path.join(outside, "review-code.md"), "VERDICT: PASS\n");
  symlinkSync(outside, path.join(s.dir, "round-1"));
  const srv = createDashboardServer({ env: s.env, dashboardDir: DASHBOARD_DIR });
  const p = await listen(srv, 0);
  const q = `repo=${s.repo}&id=${s.id}`;
  const fetchJson = (u) => new Promise((resolve) => http.get({ host: "127.0.0.1", port: p, path: u, headers: { Host: `127.0.0.1:${p}` } }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, body: b }));
  }));
  assert.deepEqual(JSON.parse((await fetchJson(`/api/files?${q}`)).body), []);
  assert.equal((await fetchJson(`/api/file?${q}&name=round-1/review-code.md`)).status, 400);
  srv.close();
});

test("gaps endpoint groups the ledger", async () => {
  const gapFile = writeJson(tempDir(), "g.json", { kind: "builder", specialty: "go", package: "P1", fallback: "factory-builder", reason: "no go builder" });
  ctl(fx.a.env, ["gap", fx.a.job, gapFile]);
  const gaps = JSON.parse((await get("/api/gaps")).body);
  assert.equal(gaps[0].specialty, "go");
});

test("the CLI reports an already-running dashboard and refuses a foreign port", async () => {
  const runDash = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BIN, "dashboard.mjs"), ...args], { env: fx.a.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("factory dashboard:")) child.kill();
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const again = await runDash(["--port", String(port)]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already running/);
  const other = http.createServer((req, res) => res.end("nope"));
  const otherPort = await listen(other, 0);
  const busy = await runDash(["--port", String(otherPort)]);
  assert.equal(busy.code, 1);
  other.close();
  assert.equal((await runDash(["--port", "abc"])).code, 1);
  const fresh = await runDash(["--port", "0"]);
  assert.match(fresh.out, /^factory dashboard: http:\/\/127\.0\.0\.1:\d+\/$/m);
});

test("render escapes HTML first and allows no links, images or raw HTML", () => {
  const html = renderHtml("# Title <b>\n<script>alert(1)</script>\n[link](javascript:alert(1)) ![img](x.png) **bold** `<code>`");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<a ") && !html.includes("<img"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>&lt;code&gt;</code>"));
  assert.ok(html.startsWith("<h1>Title &lt;b&gt;</h1>"));
  assert.equal(escapeHtml(`"'&`), "&quot;&#39;&amp;");
});

test("render badges only an exact first-line verdict", () => {
  assert.equal(parseMarkdown("VERDICT: PASS\nok").badge, "pass");
  assert.equal(parseMarkdown("VERDICT: CHANGES\n").badge, "changes");
  assert.equal(parseMarkdown("APPROVE\nreason").badge, "approve");
  assert.equal(parseMarkdown("ESCALATE\nreason").badge, "escalate");
  ["VERDICT: PASS ", " VERDICT: PASS", "verdict: pass", "APPROVED", "ok\nVERDICT: PASS"].forEach((md) =>
    assert.equal(parseMarkdown(md).badge, null, JSON.stringify(md))
  );
  assert.match(renderHtml("APPROVE\nfine"), /^<span class="badge badge-approve">APPROVE<\/span><p>fine<\/p>$/);
});

test("render handles lists, tables, fenced code and paragraphs", () => {
  const md = "## H\n- a\n- **b**\n1. one\n2. two\n\n| AC | Test |\n|---|---|\n| AC-1 | `t` |\n\n```\n<raw> & co\n```\npara\nline two\n# next";
  const { blocks } = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "list", "list", "table", "code", "p", "heading"]);
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[3].rows[0][1][0].t, "code");
  assert.equal(blocks[4].text, "<raw> & co");
  assert.equal(blocks[5].inline[0].v, "para line two");
  const html = renderHtml(md);
  assert.ok(html.includes("<table><thead><tr><th>AC</th><th>Test</th></tr></thead>"));
  assert.ok(html.includes("<ol><li>one</li><li>two</li></ol>"));
  assert.ok(html.includes("<pre><code>&lt;raw&gt; &amp; co</code></pre>"));
  assert.deepEqual(parseInline("``"), [{ t: "text", v: "``" }]);
  assert.equal(parseMarkdown("```\nunterminated").blocks[0].text, "unterminated");
});
