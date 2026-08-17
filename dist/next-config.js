// src/next-config.ts
import { withPostHogConfig } from "@posthog/nextjs-config";
var POSTHOG_UI_HOSTS = new Set([
  "https://eu.posthog.com",
  "https://us.posthog.com"
]);
function resolvePostHogSourceMapConfig(options) {
  const environment = options.environment ?? process.env;
  const personalApiKey = environment.POSTHOG_API_KEY;
  const projectId = environment.POSTHOG_PROJECT_ID;
  const releaseVersion = environment.VERCEL_GIT_COMMIT_SHA;
  const host = environment.POSTHOG_UI_HOST ?? "https://us.posthog.com";
  if (environment.VERCEL_ENV !== "production" || !personalApiKey?.startsWith("phx_") || !projectId?.match(/^[1-9]\d*$/u) || !releaseVersion || !POSTHOG_UI_HOSTS.has(host)) {
    return null;
  }
  return {
    personalApiKey,
    projectId,
    host,
    logLevel: "error",
    sourcemaps: {
      enabled: true,
      releaseName: options.siteId,
      releaseVersion,
      deleteAfterUpload: true
    }
  };
}
function withPostHogSourceMaps(nextConfig, options) {
  const config = resolvePostHogSourceMapConfig(options);
  return config ? withPostHogConfig(nextConfig, config) : nextConfig;
}
export {
  withPostHogSourceMaps,
  resolvePostHogSourceMapConfig
};

//# debugId=0C9BA2443720F98A64756E2164756E21
