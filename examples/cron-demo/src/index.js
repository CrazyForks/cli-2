const LAST_TICK_KEY = "last_tick";
const COUNT_KEY = "tick_count";

export default {
  async fetch(_request, env) {
    const lastTick = await env.CRON_STATE.get(LAST_TICK_KEY, { type: "json" });
    const count = Number((await env.CRON_STATE.get(COUNT_KEY)) || "0");

    return Response.json({
      ok: true,
      count,
      lastTick,
      hint: "scheduled() runs every minute; refresh after the next cron slot",
    });
  },

  async scheduled(controller, env) {
    const count = Number((await env.CRON_STATE.get(COUNT_KEY)) || "0") + 1;
    const tick = {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      ranAt: new Date().toISOString(),
      count,
    };

    await env.CRON_STATE.put(COUNT_KEY, String(count));
    await env.CRON_STATE.put(LAST_TICK_KEY, JSON.stringify(tick));
  },
};
