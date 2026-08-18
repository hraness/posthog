# @hraness/posthog

`@hraness/posthog` provides privacy-preserving PostHog primitives for Next.js applications. It validates sites and events, canonicalizes routes, classifies traffic, sanitizes provider payloads, bounds exception reporting, and uploads source maps only for an exact production build.

Consumers own their site definition, route taxonomy, event meaning, and conversion rules. The package does not include product configuration or UI.

## Install

Pin the immutable GitHub release and install the framework peers used by your application:

```json
{
  "dependencies": {
    "@hraness/posthog": "github:hraness/posthog#v0.1.2",
    "next": "16.2.12",
    "react": "19.2.3"
  }
}
```

## Define a site

```ts
import {
  POSTHOG_SCHEMA_VERSION,
  type PostHogSiteDefinition,
} from "@hraness/posthog";

export const analyticsSite = {
  id: "docs",
  canonicalDomain: "docs.example.com",
  allowedHosts: ["docs.example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [
    { match: "exact", path: "/", pageKind: "home" },
    {
      match: "prefix",
      path: "/guides",
      pageKind: "guide",
      contentGroup: "documentation",
      captureSlug: true,
    },
  ],
  customEvents: ["guide_opened"],
  stripQueryAttribution: true,
} satisfies PostHogSiteDefinition;
```

## Capture browser events

Mount the React integration once in your application shell:

```tsx
import { PostHogAnalytics } from "@hraness/posthog/react";

<PostHogAnalytics
  site={analyticsSite}
  apiKey={process.env.NEXT_PUBLIC_POSTHOG_KEY}
/>;
```

Capture only event names declared by the site:

```ts
import { capturePostHogEvent } from "@hraness/posthog/client";

capturePostHogEvent(analyticsSite, "guide_opened", {
  guide_kind: "reference",
});
```

Browser capture activates only in production, on an allowed host, with a public `phc_` project token. It uses memory-only cookieless persistence, anonymous profiles, explicit event allowlists, URL sanitization, and bounded exception capture. Invalid configuration is a no-op.

## Report server exceptions

```ts
import { createPostHogRequestErrorReporter } from "@hraness/posthog/server";

export const onRequestError = createPostHogRequestErrorReporter({
  site: analyticsSite,
  apiKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
});
```

The reporter accepts only production requests on an allowed host, applies route and traffic context, limits repeated fingerprints, and swallows provider failures so observability cannot break a request.

## Upload source maps

```ts
import { withPostHogSourceMaps } from "@hraness/posthog/next-config";

export default withPostHogSourceMaps(nextConfig, { siteId: analyticsSite.id });
```

Source-map upload requires `VERCEL_ENV=production`, `POSTHOG_API_KEY` with a personal `phx_` token, a numeric `POSTHOG_PROJECT_ID`, and `VERCEL_GIT_COMMIT_SHA`. Generated source maps are deleted after upload.

## Export boundaries

- `@hraness/posthog` and `@hraness/posthog/site` are provider-neutral route and site utilities.
- `@hraness/posthog/event` and `@hraness/posthog/traffic` are provider-neutral data utilities.
- `@hraness/posthog/client` is browser-only and imports PostHog.js.
- `@hraness/posthog/react` adds React components.
- `@hraness/posthog/server` is Node-only and imports PostHog Node.
- `@hraness/posthog/next-config` is build-time-only.

## Development

Use Bun 1.3.14 and Node 24:

```sh
bun install --frozen-lockfile
bun run check
```

The package is available under the [MIT License](LICENSE).
