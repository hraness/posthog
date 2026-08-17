import { withPostHogConfig } from "@posthog/nextjs-config";
import type { NextConfig } from "next";

const POSTHOG_UI_HOSTS = new Set([
  "https://eu.posthog.com",
  "https://us.posthog.com",
]);

export type PostHogSourceMapEnvironment = Readonly<Record<string, string | undefined>>;

export type PostHogSourceMapOptions = Readonly<{
  siteId: string;
  environment?: PostHogSourceMapEnvironment;
}>;

export type ResolvedPostHogSourceMapConfig = Readonly<{
  personalApiKey: string;
  projectId: string;
  host: string;
  logLevel: "error";
  sourcemaps: Readonly<{
    enabled: true;
    releaseName: string;
    releaseVersion: string;
    deleteAfterUpload: true;
  }>;
}>;

export function resolvePostHogSourceMapConfig(
  options: PostHogSourceMapOptions,
): ResolvedPostHogSourceMapConfig | null {
  const environment = options.environment ?? process.env;
  const personalApiKey = environment.POSTHOG_API_KEY;
  const projectId = environment.POSTHOG_PROJECT_ID;
  const releaseVersion = environment.VERCEL_GIT_COMMIT_SHA;
  const host = environment.POSTHOG_UI_HOST ?? "https://us.posthog.com";
  if (
    environment.VERCEL_ENV !== "production"
    || !personalApiKey?.startsWith("phx_")
    || !projectId?.match(/^[1-9]\d*$/u)
    || !releaseVersion
    || !POSTHOG_UI_HOSTS.has(host)
  ) {
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
      deleteAfterUpload: true,
    },
  };
}

export function withPostHogSourceMaps(
  nextConfig: NextConfig,
  options: PostHogSourceMapOptions,
): NextConfig {
  const config = resolvePostHogSourceMapConfig(options);
  return config ? withPostHogConfig(nextConfig, config) : nextConfig;
}
