import { expect, test } from "bun:test";

import { resolvePostHogSourceMapConfig } from "./next-config";

test("source maps remain inert without complete production credentials", () => {
  expect(resolvePostHogSourceMapConfig({
    siteId: "example",
    environment: { VERCEL_ENV: "preview" },
  })).toBeNull();
  expect(resolvePostHogSourceMapConfig({
    siteId: "example",
    environment: {
      VERCEL_ENV: "production",
      POSTHOG_API_KEY: "phx_secret",
      POSTHOG_PROJECT_ID: "1",
    },
  })).toBeNull();
  expect(resolvePostHogSourceMapConfig({
    siteId: "example",
    environment: {
      VERCEL_ENV: "production",
      POSTHOG_API_KEY: "phx_secret",
      POSTHOG_PROJECT_ID: "not-a-project",
      VERCEL_GIT_COMMIT_SHA: "abc123",
    },
  })).toBeNull();
  expect(resolvePostHogSourceMapConfig({
    siteId: "example",
    environment: {
      VERCEL_ENV: "production",
      POSTHOG_API_KEY: "phx_secret",
      POSTHOG_PROJECT_ID: "1",
      POSTHOG_UI_HOST: "https://attacker.example",
      VERCEL_GIT_COMMIT_SHA: "abc123",
    },
  })).toBeNull();
});

test("source maps use a commit-derived release and delete uploaded artifacts", () => {
  expect(resolvePostHogSourceMapConfig({
    siteId: "example",
    environment: {
      VERCEL_ENV: "production",
      POSTHOG_API_KEY: "phx_secret",
      POSTHOG_PROJECT_ID: "1",
      VERCEL_GIT_COMMIT_SHA: "abc123",
    },
  })).toEqual({
    personalApiKey: "phx_secret",
    projectId: "1",
    host: "https://us.posthog.com",
    logLevel: "error",
    sourcemaps: {
      enabled: true,
      releaseName: "example",
      releaseVersion: "abc123",
      deleteAfterUpload: true,
    },
  });
});
