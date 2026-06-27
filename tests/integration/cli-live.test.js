import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { controlFetch } from "../../lib/control-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, "../..");
const WDL_BIN = path.join(CLI_ROOT, "bin", "wdl.js");
const LOCAL_GATEWAY_PORT = process.env.WDL_GATEWAY_HOST_PORT || "8080";
const DEFAULT_LOCAL_CONTROL_URL = `http://admin.test:${LOCAL_GATEWAY_PORT}`;
const DEFAULT_LOCAL_ADMIN_TOKEN = "local-dev-token";
const DEFAULT_LOCAL_PLATFORM_DOMAIN = "workers.local";
const DEFAULT_LOCAL_GATEWAY_ORIGIN = `http://localhost:${LOCAL_GATEWAY_PORT}`;
const LIVE_TIMEOUT_MS = 20 * 60_000;
const TENANT_REQUEST_TIMEOUT_MS = 30_000;

test("live CLI integration covers command surface against a WDL control plane", {
  timeout: LIVE_TIMEOUT_MS,
}, async (t) => {
  const ctx = createLiveContext();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "wdl-cli-live-"));
  const cleanup = [];
  let appDir = "";
  let wfDir = "";
  let initDir = "";
  let storeEnv = null;
  const cleaned = {
    appWorker: false,
    d1: false,
  };

  const cleanupStep = (label, fn) => {
    cleanup.push(async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup warning (${label}): ${err?.message || String(err)}`);
      }
    });
  };
  const step = (name, fn) => runStep(t, name, fn);

  try {
    const activeTenant = await runStep(t, "preflight and temporary tenant token", async () => {
      await assertControlReachable(ctx);
      const provisioned = await provisionTenantToken(ctx);
      cleanupStep("temporary tokens", () => provisioned.revoke?.());
      return provisioned;
    });
    if (!activeTenant) throw new Error("preflight did not provision a tenant token");

    const ns = activeTenant.ns;
    const appWorker = "cli-live-app";
    const wfWorker = "cli-live-wf";
    const dbName = `${ns}-main`;
    const bucket = `cli-live-${ns}`;
    const kvId = `${ns}-kv`;
    const objectKey = `objects/${ns}/sample.txt`;
    const xdg = path.join(tempRoot, "xdg");
    const commonEnv = integrationEnv(ctx, { XDG_CONFIG_HOME: xdg });
    const noCliEnv = withoutCliControlEnv(commonEnv);
    const directTenantEnv = integrationEnv(ctx, {
      XDG_CONFIG_HOME: xdg,
      ADMIN_TOKEN: activeTenant.token,
      CONTROL_URL: ctx.controlUrl,
      WDL_NS: ns,
    });

    const run = (args, options = {}) => runWdl(args, {
      cwd: options.cwd || CLI_ROOT,
      env: {
        ...commonEnv,
        ...(options.env || {}),
      },
      input: options.input,
      timeoutMs: options.timeoutMs,
    });
    const runJson = (args, options = {}) => JSON.parse(run(args, options).stdout);

    await step("top-level help and command help", () => {
      run(["--version"]);
      run(["help"]);
      for (const command of [
        "init", "deploy", "secret", "secrets", "workers", "delete", "d1", "r2",
        "tail", "workflows", "token", "config", "doctor", "whoami",
      ]) {
        run([command, "--help"]);
      }
    });

    await step("init command scaffolds a project", () => {
      initDir = path.join(tempRoot, "init-project");
      run(["init", "init-project", "--ns", ns, "--worker", "init-worker"], { cwd: tempRoot });
      assert.match(readFileSync(path.join(initDir, "wrangler.jsonc"), "utf8"), /2026-05-31/);
    });

    await step("token store commands", () => {
      run([
        "token", "set",
        "--ns", ns,
        "--control-url", ctx.controlUrl,
        "--label", "live integration",
        "--default",
      ], {
        input: `${activeTenant.token}\n`,
        env: noCliEnv,
      });
      const tokenList = runJson(["token", "list", "--json"], {
        env: noCliEnv,
      });
      assert.equal(tokenList[0]?.namespace, ns);
      run(["token", "use", ns], { env: noCliEnv });
      storeEnv = noCliEnv;
    });

    await step("config, whoami, and doctor commands", () => {
      const config = runJson(["config", "explain", "--json"], { env: storeEnv });
      assert.equal(config.namespace.value, ns);
      const whoami = runJson(["whoami", "--json"], { env: storeEnv });
      assert.equal(whoami.namespace.value, ns);
      assert.equal(whoami.namespace.matchesConfigured, true);
      const doctor = runJson(["doctor", "--json"], { env: storeEnv, cwd: initDir });
      assert.ok(Array.isArray(doctor.checks));
    });

    await step("write live app and workflow fixtures", () => {
      appDir = writeAppProject(tempRoot, { worker: appWorker, dbName, bucket, kvId });
      wfDir = writeWorkflowProject(tempRoot, { worker: wfWorker });
    });

    cleanupStep("delete d1 database", () => {
      if (!cleaned.d1) run(["d1", "delete", dbName, "--yes", "--json"], { env: directTenantEnv });
    });
    cleanupStep("delete app worker", () => {
      if (!cleaned.appWorker) run(["delete", "worker", appWorker, "--yes", "--json"], { env: directTenantEnv });
    });
    cleanupStep("delete workflow worker", () => {
      try {
        run(["delete", "worker", wfWorker, "--yes", "--json"], { env: directTenantEnv });
      } catch (err) {
        if (String(err?.message || err).includes("workflow_instances_active")) {
          console.error(`cleanup note: ${ns}/${wfWorker} is retained until workflow instance retention expires`);
          return;
        }
        throw err;
      }
    });

    await step("d1 commands create, migrate, list, execute", () => {
      const createdDb = runJson(["d1", "create", dbName, "--json"], { env: storeEnv });
      assert.equal(createdDb.databaseName, dbName);
      assert.ok(runJson(["d1", "list", "--json"], { env: storeEnv }).databases.some((db) =>
        db.databaseName === dbName
      ));
      runJson(["d1", "migrations", "status", dbName, "--dir", "migrations", "--json"], {
        cwd: appDir,
        env: storeEnv,
      });
      runJson(["d1", "migrations", "apply", dbName, "--dir", "migrations", "--json"], {
        cwd: appDir,
        env: storeEnv,
      });
      runJson(["d1", "migrations", "list", dbName, "--json"], { env: storeEnv });
      runJson(["d1", "execute", dbName, "--sql", "select count(*) as n from cli_live_items", "--json"], {
        env: storeEnv,
      });
    });

    await step("deploy command publishes app worker", async () => {
      const firstDeploy = run(["deploy", appDir], { env: storeEnv, timeoutMs: 5 * 60_000 });
      assertDeployPrintedLiveVersion(firstDeploy.stdout);
      await waitForTenantJson(ctx, ns, appWorker, "/health", (body) => body.worker === appWorker);
    });

    await step("secret and secrets commands", () => {
      run(["secret", "put", "--scope", "ns", "LIVE_NS_SECRET"], {
        input: "ns-secret\n",
        env: storeEnv,
      });
      assert.ok(
        runJson(["secret", "list", "--scope", "ns", "--json"], { env: storeEnv }).keys.includes("LIVE_NS_SECRET")
      );
      run(["secrets", "list", "--scope", "ns"], { env: storeEnv });

      run(["secret", "put", "--worker", appWorker, "LIVE_WORKER_SECRET"], {
        input: "worker-secret\n",
        env: storeEnv,
      });
      assert.ok(
        runJson(["secret", "list", "--worker", appWorker, "--json"], { env: storeEnv })
          .keys.includes("LIVE_WORKER_SECRET")
      );
    });

    await step("tenant runtime exercises D1, R2, and KV bindings", async () => {
      const d1ViaWorker = await tenantJson(ctx, ns, appWorker, "/d1?name=alice", { method: "POST" });
      assert.equal(d1ViaWorker.name, "alice");

      const r2Put = await tenantJson(ctx, ns, appWorker, `/r2?key=${encodeURIComponent(objectKey)}`, {
        method: "POST",
      });
      assert.equal(r2Put.key, objectKey);

      const kvPut = await tenantJson(ctx, ns, appWorker, "/kv?key=counter");
      assert.deepEqual(kvPut, { key: "counter", value: 1 });
    });

    await step("r2 commands list, head, get, delete objects", () => {
      assert.ok(runJson(["r2", "buckets", "list", "--json"], { env: storeEnv }).buckets.some((b) => b.name === bucket));
      assert.ok(runJson(["r2", "objects", "list", bucket, "--prefix", `objects/${ns}/`, "--json"], {
        env: storeEnv,
      }).objects.some((obj) => obj.key === objectKey));
      assert.equal(runJson(["r2", "objects", "head", bucket, objectKey, "--json"], { env: storeEnv }).key, objectKey);
      const outFile = path.join(tempRoot, "r2-object.txt");
      run(["r2", "objects", "get", bucket, objectKey, "--out", outFile], { env: storeEnv });
      assert.equal(readFileSync(outFile, "utf8"), "live-r2-body");
      runJson(["r2", "objects", "delete", bucket, objectKey, "--yes", "--json"], { env: storeEnv });
    });

    await step("tail command receives live logs", async () => {
      await assertTailReceivesLog({ ctx, ns, worker: appWorker, env: storeEnv });
    });

    await step("workers and delete version commands", () => {
      writeAppRevision(appDir, appWorker, "v2");
      const secondDeploy = run(["deploy", appDir], { env: storeEnv, timeoutMs: 5 * 60_000 });
      assertDeployPrintedLiveVersion(secondDeploy.stdout);
      const workers = runJson(["workers", "--json"], { env: storeEnv });
      const app = workers.workers.find((worker) => worker.name === appWorker);
      assert.ok(app?.activeVersion, `workers list did not include an active version for ${appWorker}`);
      assert.ok(app.versions.includes(app.activeVersion));
      const oldVersion = app.versions.find((version) => version && version !== app.activeVersion);
      assert.ok(oldVersion, `second deploy did not leave an old version: ${app.versions.join(", ")}`);
      runJson(["delete", "version", appWorker, oldVersion, "--json"], { env: storeEnv });
      runJson(["delete", "worker", appWorker, "--dry-run", "--json"], { env: storeEnv });
    });

    await step("secret delete commands", () => {
      run(["secret", "delete", "--scope", "ns", "LIVE_NS_SECRET", "--yes"], { env: storeEnv });
      run(["secret", "delete", "--worker", appWorker, "LIVE_WORKER_SECRET", "--yes"], { env: storeEnv });
    });

    await step("workflows commands", async () => {
      run(["deploy", wfDir], { env: storeEnv, timeoutMs: 5 * 60_000 });
      assert.ok(runJson(["workflows", "list", "--json"], { env: storeEnv }).workflows.some((wf) =>
        wf.worker === wfWorker && wf.name === "orders"
      ));
      await waitForTenantJson(ctx, ns, wfWorker, "/health", (body) => body.worker === "workflow");
      await tenantJson(ctx, ns, wfWorker, "/workflow/start?id=live-wait&wait=1");
      await waitForWorkflowStatus(runJson, storeEnv, wfWorker, "orders", "live-wait", ["waiting", "queued", "running"]);
      runJson(["workflows", "instances", wfWorker, "orders", "--limit", "5", "--json"], { env: storeEnv });
      runJson([
        "workflows", "status", wfWorker, "orders", "live-wait",
        "--include-steps", "--step-limit", "10", "--json",
      ], { env: storeEnv });
      runJson(["workflows", "pause", wfWorker, "orders", "live-wait", "--json"], { env: storeEnv });
      runJson(["workflows", "resume", wfWorker, "orders", "live-wait", "--json"], { env: storeEnv });
      runJson(["workflows", "restart", wfWorker, "orders", "live-wait", "--yes", "--json"], { env: storeEnv });
      runJson(["workflows", "terminate", wfWorker, "orders", "live-wait", "--yes", "--json"], { env: storeEnv });
    });

    await step("explicit cleanup commands", () => {
      runJson(["delete", "worker", appWorker, "--yes", "--json"], { env: storeEnv });
      cleaned.appWorker = true;
      runJson(["d1", "delete", dbName, "--yes", "--json"], { env: storeEnv });
      cleaned.d1 = true;
      run(["token", "rm", "--ns", ns], { env: noCliEnv });
    });
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createLiveContext() {
  const controlUrl = normalizeControlUrl(process.env.WDL_LIVE_CONTROL_URL || DEFAULT_LOCAL_CONTROL_URL);
  const controlHost = new URL(controlUrl).hostname;
  const isLocalControl = controlHost === "localhost" ||
    controlHost === "127.0.0.1" ||
    controlHost.endsWith(".test") ||
    controlHost.endsWith(".local");
  const connectHost = process.env.WDL_LIVE_CONTROL_CONNECT_HOST ||
    (isLocalControl ? "localhost" : "");
  if (connectHost) process.env.CONTROL_CONNECT_HOST = connectHost;
  else delete process.env.CONTROL_CONNECT_HOST;

  return {
    controlUrl,
    controlConnectHost: connectHost,
    adminToken: process.env.WDL_LIVE_ADMIN_TOKEN || (isLocalControl ? DEFAULT_LOCAL_ADMIN_TOKEN : ""),
    issuerToken: process.env.WDL_LIVE_ISSUER_TOKEN || "",
    template: process.env.WDL_LIVE_TEMPLATE || "wdl-cli-integration",
    platformDomain: process.env.WDL_LIVE_PLATFORM_DOMAIN || DEFAULT_LOCAL_PLATFORM_DOMAIN,
    gatewayOrigin: process.env.WDL_LIVE_GATEWAY_ORIGIN || (isLocalControl ? DEFAULT_LOCAL_GATEWAY_ORIGIN : ""),
  };
}

function normalizeControlUrl(value) {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

function integrationEnv(ctx, overlay = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    CONTROL_URL: ctx.controlUrl,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_HIDE_BANNER: "true",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    NO_PROXY: "localhost,127.0.0.1,::1,admin.test",
    no_proxy: "localhost,127.0.0.1,::1,admin.test",
    ...overlay,
  };
  if (ctx.controlConnectHost) env.CONTROL_CONNECT_HOST = ctx.controlConnectHost;
  else delete env.CONTROL_CONNECT_HOST;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.WDL_LIVE_ADMIN_TOKEN;
  delete env.WDL_LIVE_ISSUER_TOKEN;
  delete env.WDL_LIVE_TENANT_TOKEN;
  return env;
}

function withoutCliControlEnv(env) {
  const clean = { ...env };
  delete clean.ADMIN_TOKEN;
  delete clean.CONTROL_URL;
  delete clean.WDL_NS;
  return clean;
}

function runWdl(args, { cwd, env, input = "", timeoutMs = 120_000 }) {
  const result = spawnSync(process.execPath, [WDL_BIN, ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `wdl ${args.join(" ")} failed with exit ${result.status}\n` +
      `stdout:\n${result.stdout}\n` +
      `stderr:\n${result.stderr}`
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * @template T
 * @param {import("node:test").TestContext} t
 * @param {string} name
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function runStep(t, name, fn) {
  let failed = null;
  /** @type {T | undefined} */
  let result;
  await t.test(name, async () => {
    try {
      result = await fn();
    } catch (err) {
      failed = err;
      throw err;
    }
  });
  if (failed) {
    throw new Error(`live integration stopped after failed step: ${name}`, { cause: failed });
  }
  return /** @type {T} */ (result);
}

async function assertControlReachable(ctx) {
  if (!ctx.adminToken) return;
  let body;
  try {
    body = await controlJson(ctx, "/whoami", ctx.adminToken);
  } catch (err) {
    throw new Error(
      `live integration preflight could not reach ${ctx.controlUrl}; ` +
      `start the local WDL dev stack or set WDL_LIVE_CONTROL_URL / token env vars. ` +
      `Underlying error: ${err?.message || String(err)}`,
      { cause: err }
    );
  }
  assert.equal(body.ok, true);
}

async function provisionTenantToken(ctx) {
  if (process.env.WDL_LIVE_TENANT_TOKEN) {
    const ns = process.env.WDL_LIVE_NS || `cli-it-${randomBytes(3).toString("hex")}`;
    return { ns, token: process.env.WDL_LIVE_TENANT_TOKEN };
  }
  if (ctx.issuerToken) {
    const delegated = await issueDelegatedTenantToken(ctx, ctx.issuerToken);
    return { ns: delegated.ns, token: delegated.token, tokenId: delegated.tokenId };
  }

  if (!ctx.adminToken) {
    throw new Error("WDL live integration needs WDL_LIVE_ISSUER_TOKEN, WDL_LIVE_TENANT_TOKEN, or an admin token");
  }
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const issuer = await controlJson(ctx, "/auth/tokens", ctx.adminToken, {
    method: "POST",
    body: {
      kind: "token-issuer",
      issueTemplates: [ctx.template],
      label: "cli live integration issuer",
      expiresAt,
    },
  });
  let delegated;
  try {
    delegated = await issueDelegatedTenantToken(ctx, issuer.token);
  } catch (err) {
    try {
      await revokeIssuedTokens(ctx, [issuer.tokenId]);
    } catch (revokeErr) {
      console.error(
        `cleanup warning (temporary issuer token): ${revokeErr?.message || String(revokeErr)}`
      );
    }
    throw err;
  }
  return {
    ns: delegated.ns,
    token: delegated.token,
    tokenId: delegated.tokenId,
    revoke: () => revokeIssuedTokens(ctx, [delegated.tokenId, issuer.tokenId]),
  };
}

async function issueDelegatedTenantToken(ctx, issuerToken) {
  try {
    return await controlJson(ctx, "/auth/delegated-tokens", issuerToken, {
      method: "POST",
      body: { template: ctx.template },
    });
  } catch (err) {
    throw new Error(
      `live integration could not issue delegated token from ${ctx.controlUrl}; ` +
      `verify the control plane is reachable and the issuer token allows template ${ctx.template}. ` +
      `Underlying error: ${err?.message || String(err)}`,
      { cause: err }
    );
  }
}

async function revokeIssuedTokens(ctx, tokenIds) {
  let firstError = null;
  for (const tokenId of tokenIds) {
    if (tokenId) {
      try {
        await controlJson(ctx, `/auth/tokens/${tokenId}`, ctx.adminToken, { method: "DELETE" });
      } catch (err) {
        firstError ??= err;
      }
    }
  }
  if (firstError) throw firstError;
}

async function controlJson(ctx, pathName, token, init = {}) {
  const headers = { "x-admin-token": token };
  let body;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await controlFetch(`${ctx.controlUrl}${pathName}`, {
    method: init.method || "GET",
    headers,
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`control ${pathName} returned non-JSON status ${res.status}: ${text}`);
  }
  if (!res.ok) {
    throw new Error(`control ${pathName} failed with status ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function writeAppProject(root, { worker, dbName, bucket, kvId }) {
  const dir = path.join(root, "app");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "migrations"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }, null, 2) + "\n");
  writeFileSync(path.join(dir, "wrangler.toml"), `
name = "${worker}"
main = "src/index.js"
compatibility_date = "2026-05-31"

[[d1_databases]]
binding = "DB"
database_name = "${dbName}"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "${bucket}"

[[kv_namespaces]]
binding = "KV"
id = "${kvId}"

[vars]
LABEL = "cli-live"
`);
  writeFileSync(path.join(dir, "migrations", "001_init.sql"), `
create table if not exists cli_live_items (
  name text primary key,
  count integer not null default 0
);
`);
  writeAppRevision(dir, worker, "v1");
  return dir;
}

function writeAppRevision(dir, worker, revision) {
  writeFileSync(path.join(dir, "src", "index.js"), appWorkerSource(worker, revision));
}

function appWorkerSource(worker, revision) {
  return `
function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ worker: "${worker}", label: env.LABEL, revision: "${revision}" });
    }
    if (url.pathname === "/d1") {
      const name = url.searchParams.get("name") || "anon";
      await env.DB.prepare(
        "insert into cli_live_items (name, count) values (?1, 1) " +
        "on conflict(name) do update set count = count + 1"
      ).bind(name).run();
      const row = await env.DB.prepare("select name, count from cli_live_items where name = ?1").bind(name).first();
      return json(row);
    }
    if (url.pathname === "/r2") {
      const key = url.searchParams.get("key") || "sample.txt";
      if (request.method === "POST") {
        await env.BUCKET.put(key, "live-r2-body", {
          httpMetadata: { contentType: "text/plain" },
          customMetadata: { source: "cli-live" },
        });
        return json({ key });
      }
      const obj = await env.BUCKET.get(key);
      return obj
        ? new Response(obj.body, { headers: { "content-type": "text/plain" } })
        : new Response("missing", { status: 404 });
    }
    if (url.pathname === "/kv") {
      const key = url.searchParams.get("key") || "counter";
      const current = Number.parseInt(await env.KV.get(key) || "0", 10) || 0;
      const next = current + 1;
      await env.KV.put(key, String(next));
      return json({ key, value: next });
    }
    if (url.pathname === "/log") {
      const id = url.searchParams.get("id") || "log";
      console.log("wdl-cli-live-log", id);
      return json({ logged: id });
    }
    return json({ error: "not_found", path: url.pathname }, { status: 404 });
  },
};
`;
}

function writeWorkflowProject(root, { worker }) {
  const dir = path.join(root, "workflow");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }, null, 2) + "\n");
  writeFileSync(path.join(dir, "wrangler.toml"), `
name = "${worker}"
main = "src/index.js"
compatibility_date = "2026-05-31"

[[workflows]]
name = "orders"
binding = "ORDERS"
class_name = "OrderWorkflow"
`);
  writeFileSync(path.join(dir, "src", "index.js"), workflowWorkerSource());
  return dir;
}

function workflowWorkerSource() {
  return `
import { WorkflowEntrypoint } from "cloudflare:workers";

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export class OrderWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};
    const prepared = await step.do("prepare", async () => ({ id: payload.id, prepared: true }));
    if (payload.wait) {
      await step.waitForEvent("approval", { type: "approval", timeout: "10m" });
    }
    return step.do("finish", async () => ({ ...prepared, finished: true }));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "live";
    if (url.pathname === "/workflow/start") {
      const instance = await env.ORDERS.create({
        id,
        params: { id, wait: url.searchParams.get("wait") === "1" },
      });
      return json({ id: instance.id });
    }
    return json({ worker: "workflow" });
  },
};
`;
}

function tenantJson(ctx, ns, worker, pathname, init = {}) {
  return tenantRequest(ctx, ns, worker, pathname, init).then(({ status, body }) => {
    if (status < 200 || status >= 300) {
      throw new Error(`tenant ${worker}${pathname} failed with ${status}: ${body}`);
    }
    return JSON.parse(body);
  });
}

async function waitForTenantJson(ctx, ns, worker, pathname, predicate) {
  let last;
  await waitUntil(`tenant ${worker}${pathname}`, async () => {
    last = await tenantJson(ctx, ns, worker, pathname).catch((err) => ({ error: err.message }));
    return predicate(last);
  });
  return last;
}

function tenantRequest(ctx, ns, worker, pathname, init = {}) {
  const platformHost = `${ns}.${ctx.platformDomain}`;
  const local = ctx.gatewayOrigin && new URL(ctx.gatewayOrigin).hostname === "localhost";
  const base = local ? new URL(ctx.gatewayOrigin) : new URL(`https://${platformHost}`);
  const lib = base.protocol === "https:" ? https : http;
  const body = init.body || null;
  const headers = { ...(init.headers || {}) };
  if (local) headers.Host = platformHost;
  const requestPath = `/${worker}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: base.hostname,
      port: Number(base.port) || (base.protocol === "https:" ? 443 : 80),
      protocol: base.protocol,
      method: init.method || "GET",
      path: requestPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(TENANT_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`tenant ${worker}${requestPath} timed out after ${TENANT_REQUEST_TIMEOUT_MS}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function assertTailReceivesLog({ ctx, ns, worker, env }) {
  const tail = spawn(process.execPath, [WDL_BIN, "tail", worker, "--raw", "--max-reconnects", "1"], {
    cwd: CLI_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  tail.stdout.setEncoding("utf8");
  tail.stderr.setEncoding("utf8");
  tail.stdout.on("data", (chunk) => { stdout += chunk; });
  tail.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitUntil("tail connection", async () => stderr.includes("tail connected"));
    const id = randomBytes(3).toString("hex");
    await tenantJson(ctx, ns, worker, `/log?id=${id}`);
    await waitUntil("tail event", async () => stdout.includes(id));
  } finally {
    tail.kill("SIGTERM");
    await waitForExit(tail);
  }
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    }),
  ]);
}

async function waitForWorkflowStatus(runJson, env, worker, workflow, instanceId, statuses) {
  let body;
  await waitUntil(`workflow ${instanceId} status`, async () => {
    body = runJson(["workflows", "status", worker, workflow, instanceId, "--include-steps", "--json"], { env });
    return statuses.includes(body.status);
  });
  return body;
}

async function waitUntil(label, fn, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function assertDeployPrintedLiveVersion(output) {
  const match = output.match(/@([^\s]+) live/);
  assert.ok(match, `deploy output did not include live version:\n${output}`);
}
