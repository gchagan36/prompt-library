// The dashboard's HTTP server: read-only, loopback-only, fixed routes, whitelisted files.
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { groupGaps, readGaps } from "./gaps.mjs";
import { listJobFiles, resolveJobFile } from "./jobfiles.mjs";
import { allJobs } from "./jobs.mjs";
import { factoryHome, jobDir, repoFile } from "./paths.mjs";
import { isSymlink } from "./store.mjs";
import { PATTERNS } from "./validate.mjs";

const STATIC = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/render.mjs": ["render.mjs", "text/javascript; charset=utf-8"]
});

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer"
});

// Fields the UI needs. Never the worktree path or the lease token hash.
const UI_FIELDS = [
  "id", "title", "feature", "issue", "target", "branch", "stage", "packages", "lenses", "round", "rounds",
  "rework", "decision", "pr", "note", "created", "updated"
];

const send = (res, status, type, body) => {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  res.end(body);
};
const json = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const text = (res, status, body) => send(res, status, "text/plain; charset=utf-8", body);

const repoName = (home, repo) => {
  try {
    if (isSymlink(repoFile(home, repo))) return repo;
    const info = JSON.parse(readFileSync(repoFile(home, repo), "utf8"));
    return typeof info.name === "string" && /^[a-z0-9-]{1,40}$/.test(info.name) ? info.name : repo;
  } catch {
    return repo;
  }
};

const pick = (state) => Object.fromEntries(UI_FIELDS.map((k) => [k, state[k]]));

export function jobsPayload(env) {
  const home = factoryHome(env);
  const names = new Map();
  const nameOf = (repo) => {
    if (!names.has(repo)) names.set(repo, repoName(home, repo));
    return names.get(repo);
  };
  return allJobs(env, home).map((j) => ({
    repo: j.repo,
    repoName: nameOf(j.repo),
    id: j.id,
    lease: j.lease,
    orphan: j.orphan,
    invalid: j.invalid ?? null,
    ...(j.state ? pick(j.state) : {})
  }));
}

// The job folder named by ?repo=&id=, or null when either is invalid.
const jobFromQuery = (home, query) => {
  const [repo, id] = [query.get("repo"), query.get("id")];
  if (!repo || !id || !PATTERNS.repo.test(repo) || !PATTERNS.id.test(id)) return null;
  const dir = jobDir(home, repo, id);
  return isSymlink(dir) ? null : dir;
};

function serveFile(res, home, query) {
  const dir = jobFromQuery(home, query);
  const name = query.get("name");
  if (dir === null || typeof name !== "string") return text(res, 400, "bad request");
  try {
    const file = resolveJobFile(dir, name);
    return file === null ? text(res, 404, "not found") : text(res, 200, readFileSync(file, "utf8"));
  } catch {
    return text(res, 400, "bad request");
  }
}

function serveStatic(res, dashboardDir, route) {
  const [file, type] = STATIC[route];
  try {
    return send(res, 200, type, readFileSync(path.join(dashboardDir, file)));
  } catch {
    return text(res, 500, "dashboard file missing");
  }
}

function route(req, res, ctx) {
  const url = new URL(req.url, "http://127.0.0.1");
  const home = factoryHome(ctx.env);
  if (Object.hasOwn(STATIC, url.pathname)) return serveStatic(res, ctx.dashboardDir, url.pathname);
  switch (url.pathname) {
    case "/api/health":
      return json(res, 200, { factory: true });
    case "/api/jobs":
      return json(res, 200, jobsPayload(ctx.env));
    case "/api/gaps":
      return json(res, 200, groupGaps(readGaps(home)));
    case "/api/files": {
      const dir = jobFromQuery(home, url.searchParams);
      return dir === null ? text(res, 400, "bad request") : json(res, 200, listJobFiles(dir));
    }
    case "/api/file":
      return serveFile(res, home, url.searchParams);
    default:
      return text(res, 404, "not found");
  }
}

// ctx: { env, dashboardDir }. The Host header must name this exact loopback port, which
// blocks DNS-rebinding pages from reading the API through a hostile hostname.
export function createDashboardServer(ctx) {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host)) return text(res, 403, "forbidden host");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return text(res, 405, "method not allowed");
    }
    try {
      return route(req, res, ctx);
    } catch {
      return text(res, 500, "error");
    }
  });
  return server;
}

export const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
