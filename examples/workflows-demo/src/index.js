import { WorkflowEntrypoint } from "cloudflare:workers";

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function boolParam(url, name) {
  const value = url.searchParams.get(name);
  return value === "1" || value === "true" || value === "";
}

function intParam(url, name, fallback = 0) {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

async function readJson(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const type = request.headers.get("content-type") || "";
  return type.includes("application/json") ? request.json() : {};
}

function instanceId(url) {
  return url.searchParams.get("id") || "order-1";
}

export class OrderWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};

    if (payload.sleepMs > 0) {
      await step.sleep("settle", payload.sleepMs);
    }

    const prepared = await step.do("prepare-order", async () => ({
      id: payload.id,
      label: this.env.LABEL,
      source: payload.source || "workflows-demo",
      preparedAt: new Date().toISOString(),
    }));

    let approval = null;
    if (payload.wait) {
      approval = await step.waitForEvent("approval", {
        type: "approval",
        timeout: "60s",
      });
    }

    return step.do("finish-order", async () => ({
      ...prepared,
      approval,
      finishedAt: new Date().toISOString(),
    }));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") {
      return json({
        worker: "workflows-demo",
        routes: {
          "GET/POST /start?id=order-1": "start an order workflow",
          "GET /status?id=order-1&steps=1": "read instance status",
          "GET/POST /approve?id=order-1": "send the approval event for waiting instances",
        },
      });
    }

    if (path === "/start") {
      const body = await readJson(request);
      const id = body.id || instanceId(url);
      const instance = await env.ORDERS.create({
        id,
        params: {
          id,
          source: body.source || "workflows-demo",
          wait: body.wait ?? boolParam(url, "wait"),
          sleepMs: body.sleepMs ?? intParam(url, "sleepMs", 0),
        },
      });
      return json({
        id: instance.id,
        status: await instance.status({ includeSteps: boolParam(url, "steps") }),
      });
    }

    if (path === "/status") {
      const instance = await env.ORDERS.get(instanceId(url));
      return json(await instance.status({ includeSteps: boolParam(url, "steps") }));
    }

    if (path === "/approve") {
      const body = await readJson(request);
      const instance = await env.ORDERS.get(body.id || instanceId(url));
      await instance.sendEvent({
        type: "approval",
        payload: {
          message: body.message || url.searchParams.get("message") || "approved",
          approvedAt: new Date().toISOString(),
        },
      });
      return json(await instance.status({ includeSteps: true }));
    }

    return json({ error: "not_found", path }, { status: 404 });
  },
};
