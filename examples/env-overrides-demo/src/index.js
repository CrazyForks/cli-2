export default {
  async fetch(request, env) {
    const assetUrl = env.ASSETS ? await env.ASSETS.url("hello.txt") : null;
    return Response.json({
      envName: env.ENV_NAME ?? null,
      baseOnly: env.BASE_ONLY ?? null,
      shared: env.SHARED ?? null,
      hasAssets: Boolean(env.ASSETS),
      assetUrl,
      path: new URL(request.url).pathname,
    });
  },
};
