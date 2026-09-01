# @hraness/posthog

[![CI](https://img.shields.io/github/actions/workflow/status/hraness/posthog/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/hraness/posthog/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hraness/posthog?style=flat-square&label=release)](https://github.com/hraness/posthog/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/hraness/posthog?style=flat-square)](LICENSE)

## Collect only the analytics your site defines

`@hraness/posthog` gives a Next.js application one typed site definition for route context, event
allowlists, traffic attribution, browser capture, bounded exception reporting, and production
source maps. The pure route, event, and traffic exports do not import a provider SDK. Browser,
server, React, and build-time adapters stay behind separate entry points.

The application owns the hosts, routes, events, conversion meaning, PostHog project, and policy for
when analytics may run. The package validates those inputs, removes or bounds sensitive provider
properties, and keeps invalid capture paths inert.

> **Distribution boundary:** Install version 0.1.2 from its immutable GitHub release tag. This
> repository publishes a verified GitHub Release and does not publish the package to npm.

## Smallest useful action

Pin the Git source release with framework versions inside the supported peer ranges:

```json
{
  "dependencies": {
    "@hraness/posthog": "github:hraness/posthog#v0.1.2",
    "next": "16.2.12",
    "react": "19.2.3"
  }
}
```

Define the site-owned analytics vocabulary in one module:

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
  delegatedEvents: ["guide_opened"],
  stripQueryAttribution: true,
  unknownCanonicalPath: "/not-found",
} satisfies PostHogSiteDefinition;
```

Then inspect the provider-neutral route result before connecting PostHog:

```ts
import { classifyAnalyticsRoute } from "@hraness/posthog";

console.log(
  JSON.stringify(
    classifyAnalyticsRoute(
      analyticsSite,
      "https://docs.example.com/guides/install?token=private#step",
    ),
    null,
    2,
  ),
);
```

```json
{
  "analytics_schema_version": 1,
  "site_id": "docs",
  "canonical_domain": "docs.example.com",
  "canonical_path": "/guides/install",
  "page_kind": "guide",
  "content_group": "documentation",
  "content_slug": "install"
}
```

This proof imports no PostHog runtime, writes no cookie, and sends no event.

## Choose the integration boundary

| Import | Runtime | Use it for | Observable result |
| --- | --- | --- | --- |
| `@hraness/posthog` or `@hraness/posthog/site` | Provider-neutral | Host validation, route normalization, and canonical context | An `AnalyticsRouteContext` or `null` |
| `@hraness/posthog/event` | Provider-neutral | Property normalization, provider sanitization, and exception budgets | Bounded properties, a sanitized error, or a budget decision |
| `@hraness/posthog/traffic` | Provider-neutral | Direct, internal, search, AI, social, and referral attribution | An `AnalyticsTrafficContext` |
| `@hraness/posthog/client` | Browser | Eligible PostHog.js initialization and approved event capture | `true` when accepted, `false` when inert |
| `@hraness/posthog/react` | React client boundary | Browser initialization, delegated clicks, and exception reporting | Components that render no interface |
| `@hraness/posthog/server` | Node | Bounded Next.js request-error reporting | An `Instrumentation.onRequestError` callback |
| `@hraness/posthog/next-config` | Build time | Exact production source-map upload | The wrapped config or the original config unchanged |

Keep each import on its intended side of the application boundary. The root export is pure. Import
browser, React, server, and build-time adapters only where those runtimes exist.

## Operator and package responsibilities

| The site owner decides | The package enforces |
| --- | --- |
| Canonical domain and approved deployment hosts | Exact normalized host membership before capture |
| Route taxonomy, page kinds, content groups, and slug capture | Canonical paths without queries or fragments, plus an optional unknown-path collapse |
| Custom and delegated event names | Built-in and site-owned allowlists before provider delivery |
| Meaning of events and conversions | Shape, count, length, URL, referrer, and credential sanitization |
| Public project token and approved ingestion host | Production, host, and `phc_` token eligibility in the default browser path |
| Whether analytics may run under the site's policy | Memory-only cookieless state, anonymous profiles, Do Not Track, and disabled recording features |
| Build-time source-map credentials | Production-only upload for an exact commit and supported PostHog UI host |

The package does not infer product events, configure the PostHog project, decide consent, or turn an
analytics property into trusted authorization state.

## Connect browser capture

Mount the React adapter once in the application shell. `NEXT_PUBLIC_POSTHOG_KEY` must contain a
public `phc_` project token.

```tsx
import { PostHogAnalytics } from "@hraness/posthog/react";

export function Analytics() {
  return (
    <PostHogAnalytics
      site={analyticsSite}
      apiKey={process.env.NEXT_PUBLIC_POSTHOG_KEY}
    />
  );
}
```

Capture a declared event from application code:

```ts
import { capturePostHogEvent } from "@hraness/posthog/client";

const accepted = capturePostHogEvent(analyticsSite, "guide_opened", {
  guide_kind: "reference",
});
```

`accepted` is `false` until the matching site is initialized or when the event name is not in
`customEvents`.

For a declared delegated event, semantic HTML can carry the bounded event name and two normalized
properties. The React adapter installs and removes the click listener.

```html
<a
  href="/guides/install"
  data-analytics-event="guide_opened"
  data-analytics-kind="navigation"
  data-analytics-id="install-guide"
>
  Read the installation guide
</a>
```

Only an event listed in `delegatedEvents` is accepted. Owned links contribute a canonical path;
foreign links contribute a hostname but not their path or query.

## Report server exceptions

Use the Node-only adapter from the Next.js instrumentation boundary:

```ts
import { createPostHogRequestErrorReporter } from "@hraness/posthog/server";

export const onRequestError = createPostHogRequestErrorReporter({
  site: analyticsSite,
  apiKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
});
```

The reporter checks production state and request host, sanitizes error and route context, limits
repeated fingerprints, disables GeoIP on the server client, and catches provider failures. An
observability failure does not change the request error path.

## Privacy contract

| Boundary | Current behavior |
| --- | --- |
| Browser eligibility | Requires production, an approved hostname, and a public `phc_` token. Caller-supplied `evidence` exists for deterministic tests and should not replace runtime evidence in application code. |
| Automatic browser capture | Captures route-bounded page views, page leave, and selected Web Vitals. General autocapture, heatmaps, dead clicks, surveys, feature flags, conversations, and session recording are disabled. |
| Browser identity and state | Uses `person_profiles: "never"`, memory persistence, cookieless mode, Do Not Track, no cross-subdomain cookie, and no device model. |
| Event allowlist | Accepts four built-in provider events plus names in `customEvents`. Delegated DOM events use their own explicit allowlist. |
| Custom properties | Keeps at most 32 valid keys. Keys are at most 64 characters, strings at most 256 characters, and arrays at most 20 primitive values. |
| Provider properties | Redacts recognized credentials and email addresses, strips URL queries and fragments, reduces third-party referrers to an origin, bounds nesting and strings, and can remove campaign attribution fields. |
| Unknown owned routes | Retains the normalized path as `page_kind: "other"`, or collapses it to `unknownCanonicalPath` when the site opts in. |
| Browser exception budget | Allows at most 20 exceptions per rolling minute and two occurrences per fingerprint. Repeated object identities are ignored. |
| Server exception budget | Allows at most 30 exceptions per rolling minute and three occurrences per fingerprint. Provider failures are swallowed. |
| Provider destination | Defaults to PostHog's US ingestion host. A caller that supplies `apiHost` owns approval of that destination. |

`stripQueryAttribution: true` still lets the traffic classifier recognize a known `utm_source` from
the current request before provider properties remove supported campaign and click identifiers.

## Inspect traffic attribution

`classifyAnalyticsTraffic()` emits one of six stable channels:

| Channel | Evidence used |
| --- | --- |
| `direct` | No usable referrer or recognized attribution source |
| `internal` | A referrer host listed in `allowedHosts` |
| `organic_search` | A recognized search referrer or `utm_source` |
| `ai_referral` | A recognized AI referrer or `utm_source` |
| `social` | A recognized social referrer or `utm_source` |
| `referral` | Another valid referrer hostname, without its path or query |

The package classifies known sources from maintained hostname lists. The consuming site decides how
those channels inform reporting or conversion analysis.

## Upload source maps at the build boundary

```ts
import { withPostHogSourceMaps } from "@hraness/posthog/next-config";

export default withPostHogSourceMaps(nextConfig, {
  siteId: analyticsSite.id,
});
```

The adapter returns the original Next.js config unless every requirement is present:

| Environment value | Requirement |
| --- | --- |
| `VERCEL_ENV` | Exactly `production` |
| `POSTHOG_API_KEY` | Build-time personal token beginning with `phx_` |
| `POSTHOG_PROJECT_ID` | Positive numeric project ID |
| `VERCEL_GIT_COMMIT_SHA` | Exact release identifier |
| `POSTHOG_UI_HOST` | `https://us.posthog.com` or `https://eu.posthog.com`; defaults to the US host |

Uploaded source maps use the site ID and commit SHA as release identity, then delete the generated
artifacts. Keep the personal token out of browser bundles, fixtures, logs, and repository files.

## Implement without widening the boundary

1. Define one `PostHogSiteDefinition` in the consuming application.
2. Prove its route classifications with the pure root export.
3. Choose the smallest runtime-specific export from the table above.
4. Keep `phc_` public project tokens separate from build-only `phx_` personal keys.
5. Declare every custom or delegated event before adding its capture call or data attribute.
6. Run the consuming application's tests in production and ineligible host scenarios.
7. Run this repository's package gate before changing an export, privacy default, or peer range.

## Questions

### Does the package send analytics in development or preview deployments?

Not through the default browser or server paths. Browser initialization requires production
runtime evidence, and the server reporter defaults to `VERCEL_ENV=production`. The explicit
`evidence` and `production` overrides exist for deterministic testing; application code should not
use them to relabel a non-production deployment.

### Does it identify people or record sessions?

No. Browser configuration uses anonymous profiles, memory-only cookieless persistence, and disables
session recording. The package still sends approved event and exception data to the configured
PostHog project when capture is eligible.

### What happens to an undeclared event?

The browser helper returns `false`, or the before-send boundary returns `null`. The event is not
delivered by this package.

### Does the package define conversions or consent policy?

No. Those decisions belong to the consuming site. This package applies technical collection
boundaries after the application decides analytics may run.

### Which Next.js versions are verified?

The package accepts Next.js 16.2 through the 16.x line. Its package smoke test installs the packed
artifact into real Next.js 16.2.12 and 16.3.1 TypeScript-config consumers, then imports every public
entry point with genuine Node 24.

## Reference

- [Site and route types](src/site.ts)
- [Event sanitization and budgets](src/event.ts)
- [Browser adapter](src/client.ts)
- [Server adapter](src/server.ts)
- [Source-map adapter](src/next-config.ts)
- [Security policy](SECURITY.md)
- [Contribution and compatibility contract](CONTRIBUTING.md)

## Development

Use Bun 1.3.14 and genuine Node 24. The aggregate gate verifies lint, types, bundle boundaries,
deterministic and property tests, a packed artifact in two Next.js
minors, portfolio inventory, public provenance, documentation contracts, and the knowledge base.

```sh
bun install --frozen-lockfile
bun run check
```

The package is available under the [MIT License](LICENSE).
