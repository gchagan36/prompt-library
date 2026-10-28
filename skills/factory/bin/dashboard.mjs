#!/usr/bin/env node
// Local, read-only factory dashboard across every repo: node dashboard.mjs [--port 8765]
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardServer, listen } from "./lib/server.mjs";

const DEFAULT_PORT = 8765;
const here = path.dirname(fileURLToPath(import.meta.url));

function parsePort(argv) {
  if (argv.length === 0) return DEFAULT_PORT;
  const ok = argv.length === 2 && argv[0] === "--port" && /^[0-9]{1,5}$/.test(argv[1]) && Number(argv[1]) <= 65535;
  if (!ok) throw new Error("usage: dashboard.mjs [--port <0-65535>]");
  return Number(argv[1]);
}

// True when a factory dashboard already answers on this port.
const isFactory = (port) =>
  new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", headers: { Host: `127.0.0.1:${port}` }, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).factory === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => req.destroy());
  });

async function main() {
  const port = parsePort(process.argv.slice(2));
  const server = createDashboardServer({ env: process.env, dashboardDir: path.join(here, "..", "dashboard") });
  try {
    const bound = await listen(server, port);
    process.stdout.write(`factory dashboard: http://127.0.0.1:${bound}/\n`);
  } catch (err) {
    if (err.code === "EADDRINUSE" && (await isFactory(port))) {
      process.stdout.write(`factory dashboard already running: http://127.0.0.1:${port}/\n`);
      return;
    }
    process.stderr.write(`dashboard: cannot listen on 127.0.0.1:${port} (${err.code || err.message})\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`dashboard: ${err.message}\n`);
  process.exitCode = 1;
});
