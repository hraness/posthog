# @hraness/posthog

[![CI](https://img.shields.io/github/actions/workflow/status/hraness/posthog/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/hraness/posthog/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hraness/posthog?style=flat-square&label=release)](https://github.com/hraness/posthog/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/hraness/posthog?style=flat-square)](LICENSE)

## Collect only the analytics your site defines

`@hraness/posthog` connects a Next.js app to PostHog from one site definition that lists your hosts,
routes, and allowed events. The browser adapter runs only on approved production hosts and sends
page views, page leaves, Web Vitals, exceptions, and the custom events you declare. It keeps its
state in memory instead of cookies, keeps only campaign parameters in URLs, and redacts recognized
credentials and email addresses. Separate adapters report server errors, with limits on repeats, and upload source maps
for production builds. The route, event, and traffic helpers run without importing PostHog.

Your app still decides its hosts, routes, events, what counts as a conversion, the PostHog project,
and when analytics may run. The package validates those inputs, strips or limits sensitive
properties before they reach PostHog, and sends nothing from a capture call that fails validation.

## Quick start

This repository does not publish the package to npm. Pin its immutable GitHub Release
tarball with framework versions inside the supported peer ranges:

```json
{
  "dependencies": {
    "@hraness/posthog": "https://github.com/hraness/posthog/releases/download/v0.3.11/hraness-posthog-0.3.11.tgz",
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
  customEvents: ["guide opened"],
  delegatedEvents: ["guide opened"],
  sensitivePaths: [{ match: "prefix", path: "/account" }],
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
  "analytics_schema_version": 2,
  "site_id": "docs",
  "canonical_domain": "docs.example.com",
  "canonical_path": "/guides/install",
  "page_kind": "guide",
  "content_group": "documentation",
  "content_slug": "install"
}
```

The route check above loads no PostHog code, writes no cookie, and sends nothing.

## Choose an entry point

| Import | Runtime | Use it for | Observable result |
| --- | --- | --- | --- |
| `@hraness/posthog` or `@hraness/posthog/site` | Provider-neutral | Host validation, route normalization, and canonical context | An `AnalyticsRouteContext` or `null` |
| `@hraness/posthog/event` | Provider-neutral | Property normalization, provider sanitization, and exception budgets | Bounded properties, a sanitized error, or a budget decision |
| `@hraness/posthog/traffic` | Provider-neutral | Direct, internal, search, AI, social, and referral attribution | An `AnalyticsTrafficContext` |
| `@hraness/posthog/consent` | Browser, provider-neutral | Shared regional consent and withdrawal | A consent subscription and transport guard |
| `@hraness/posthog/client` | Browser | Eligible PostHog.js initialization and approved event capture | `true` when accepted, `false` when inert |
| `@hraness/posthog/react` | React client boundary | Browser initialization, delegated clicks, and exception reporting | Components that render no interface |
| `@hraness/posthog/server` | Node | Next.js request errors and anonymous server events | An error callback or a delivery result |
| `@hraness/posthog/next-config` | Build time | Exact production source-map upload | The wrapped config or the original config unchanged |
| `@hraness/posthog/testing` | Node or Bun test runner | Running real PostHog.js events through your site's production config | Decoded outgoing requests and a list of contract violations |

Keep each import on its intended side of the application boundary. The root export is pure. Import
browser, React, server, and build-time adapters only where those runtimes exist.

## What you decide and what the package enforces

| The site owner decides | The package enforces |
| --- | --- |
| Canonical domain and approved deployment hosts | Exact normalized host membership before capture |
| Route taxonomy, page kinds, content groups, and slug capture | Canonical paths without queries or fragments, plus an optional unknown-path collapse |
| Custom and delegated event names | Built-in and site-owned allowlists before provider delivery |
| Meaning of events and conversions | Shape, count, length, URL, referrer, and credential sanitization |
| Public project token and approved ingestion host | Production, host, and `phc_` token eligibility in the default browser path |
| Whether analytics may run under the site's policy | Memory-only cookieless state, anonymous profiles, Do Not Track, and disabled recording features |
| Build-time source-map credentials | Production-only upload for an exact commit and supported PostHog UI host |

The package does not infer product events, configure the PostHog project, or turn an
analytics property into trusted authorization state.

## Connect browser capture

Mount the React adapter once in the application shell. `NEXT_PUBLIC_POSTHOG_KEY` must contain a
public `phc_` project token.

Web Vitals callbacks are bundled with the browser adapter. They do not require
allowing a remote script host in your Content Security Policy. Keep the approved
ingestion host in `connect-src` for the analytics requests your policy permits.

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

const accepted = capturePostHogEvent(analyticsSite, "guide opened", {
  guide_kind: "reference",
});
```

`accepted` is `false` until the matching site is initialized or when the event name is not in
`customEvents`.

The client export also has helpers for `"cta clicked"`, `"install command copied"`, and
`"outbound link opened"`. Add the names you use to `customEvents` in the site definition
before calling these helpers. Each returns `false` if the event is undeclared or a property is invalid:

```ts
import {
  capturePostHogCtaClicked,
  capturePostHogInstallCommandCopied,
  capturePostHogOutboundLinkOpened,
} from "@hraness/posthog/client";

capturePostHogCtaClicked(analyticsSite, { cta: "start_trial", placement: "hero" });
capturePostHogInstallCommandCopied(analyticsSite, { installMethod: "brew", placement: "hero" });
capturePostHogOutboundLinkOpened(analyticsSite, { targetHost: "github.com", placement: "footer" });
```

Mount `PostHogPageNotFound` from `@hraness/posthog/react` in your 404 page. It sends one
`page not found` event with the requested path, without its query or fragment, and the referring
host.

The missing-page reporter honors `unknownCanonicalPath`, so a site that collapses
unknown URLs to `/private` keeps that policy in `requested_path` too. Excluded
requested paths are not captured.

For a declared delegated event, semantic HTML can carry the bounded event name and two normalized
properties. The React adapter installs and removes the click listener.

```html
<a
  href="/guides/install"
  data-analytics-event="guide opened"
  data-analytics-kind="navigation"
  data-analytics-id="install-guide"
>
  Read the installation guide
</a>
```

Only an event listed in `delegatedEvents` is accepted. Owned links contribute a canonical path;
foreign links contribute a hostname but not their path or query.

Client exceptions that occur before regional permission or acceptance are dropped; they are not replayed later.

### Count outbound links

Register `"outbound link opened"` in `customEvents` and pass `captureOutboundLinks`
to `<PostHogAnalytics>`. This opt-in observer records only the external HTTP(S)
hostname and a bounded placement. Owned host aliases, non-web links, private routes,
and declined consent are excluded. The default installs no outbound observer;
link text, external paths, queries, and fragments are never sent.

### Deduplicate browser conversions

The browser `capturePostHogEvent(site, event, properties, { uuid })` and
`<PostHogEventReporter uuid={uuid} ... />` accept a valid, stable event UUID for
verified conversions. Derive it server-side from an event-scoped secret and transaction
identity; never send the raw order, session, or customer identifier. The pinned SDK
emits this value as the top-level event `uuid`. PostHog can eventually deduplicate
matching UUIDs; capture still sends retries, and immediate exactly-once delivery is
not guaranteed. A `$insert_id` property alone is not this transport option.

## Send server events

Use the server export from a trusted server handler. It requires
production, an allowed served hostname, and an event in `customEvents`. It sends a fixed
anonymous server identity, removes sensitive properties, and returns `false` on delivery failure.
Do not pass customer identifiers or user input.

```ts
import { capturePostHogEvent } from "@hraness/posthog/server";

await capturePostHogEvent({ site: analyticsSite, apiKey: process.env.NEXT_PUBLIC_POSTHOG_KEY }, {
  event: "guide opened",
  hostname: "docs.example.com",
  properties: { guide_kind: "reference" },
});
```

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
| Provider properties | Keeps `utm_*` and ad click IDs as properties and as the only URL query parameters. Removes every other query parameter and every fragment, redacts email addresses, credentials, OAuth `code` and `state`, and `email`, `token`, `code`, `key`, and `secret` values, reduces third-party referrers to an origin, and bounds nesting and strings. |
| Sensitive paths | Removes the whole query, campaign parameters included, on routes listed in `sensitivePaths`, such as sign-in, auth callbacks, account, billing, and invite links. |
| Unknown owned routes | Retains the normalized path as `page_kind: "other"`, or collapses it to `unknownCanonicalPath` when the site opts in. |
| Browser exception budget | Allows at most 20 exceptions per rolling minute and two occurrences per fingerprint. Repeated object identities are ignored. |
| Server exception budget | Allows at most 30 exceptions per rolling minute and three occurrences per fingerprint. Provider failures are swallowed. |
| Provider destination | Defaults to PostHog's US ingestion host. A caller that supplies `apiHost` owns approval of that destination. |

### Choose attribution and route privacy

The default `attributionMode: "campaign"` keeps allowlisted campaign attribution on
public routes. Emitted paths, slugs, property strings, and exception fields redact identifiers before
length limits. Inspection recognizes percent-encoded email addresses (including Unicode)
and credentials without decoding unrelated URL separators. It inspects at most eight
encoding layers and 32,768 characters: unresolved encodings redact their original path
segment, and oversized strings become `[redacted]`. Route eligibility still uses
the original location; redaction does not make a private route eligible.

Set `attributionMode: "referrer_only"` to remove campaign queries and
properties on every route, including initial and session-entry values, and classify
traffic only from the referrer.

Set `privacyMode: "minimal"` to also reduce owned and external referrers to origins
and enable PostHog's personal-data masking. It removes campaign queries and
properties, including initial and session attribution. The default `"standard"` mode
keeps allowlisted campaign attribution unless `attributionMode` removes it.

The deprecated `stripQueryAttribution` field has no effect. When upgrading a site
that used it to discard query attribution, choose `"referrer_only"` or `"minimal"`
and update the site's regression fixtures before deploying.

Private routes can opt out completely with `excludedPaths`. Use `allowedPaths` to
limit analytics to a public section. Both accept `{ match: "exact" | "prefix", path: string }`
rules; prefixes match path segments, exclusions win, and an empty allowlist disables
all routes. The client checks both the live and captured URL before sending,
including after SPA navigation. Server helpers use the same route policy.
`sensitivePaths` removes attribution but does not exclude events. Existing route
rules and `unknownCanonicalPath` still control private and unknown path disclosure.

Browser events use immediate fetch requests with a consent-scoped abort signal.
Withdrawing consent aborts pending requests and their retries; accepting again
allows new events without reviving earlier requests. Page leaves use fetch with
keepalive instead of sendBeacon so they obey the same cancellation.
Events include `analytics_schema_version: 2`.

## Test your site against real PostHog.js

`@hraness/posthog/testing` loads PostHog.js in a child process with a stubbed `fetch`, initializes
it with your site's production config, and checks the outgoing requests. It captures page views,
page leaves, Web Vitals, an exception, and your custom events from a URL with campaign parameters,
an email, and an OAuth code, then from a sensitive path.

```ts
import { expect, test } from "bun:test";
import { checkPostHogContract } from "@hraness/posthog/testing";

test("analytics requests keep what PostHog needs and drop personal data", () => {
  const { violations } = checkPostHogContract({
    site: analyticsSite,
    sensitivePath: "/account",
    customEvents: [{ event: "guide opened", properties: { guide_kind: "reference" } }],
  });
  expect(violations).toEqual([]);
});
```

`runPostHogHarness` returns the decoded requests if you want to write your own assertions.
Both helpers test the package configuration for your site definition. If your application
replaces `before_send` or changes other production options, run those actual options in your
own SDK harness as well; the package helper does not test application overrides.

After a sensitive route, the browser instance drops campaign properties and URL attribution
on subsequent routes too, because the SDK can retain private landing attribution in memory.

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

## Integration checklist

1. Define one `PostHogSiteDefinition` in the consuming application.
2. Prove its route classifications with the pure root export.
3. Choose the smallest runtime-specific export from the table above.
4. Keep `phc_` public project tokens separate from build-only `phx_` personal keys.
5. Declare every custom or delegated event before adding its capture call or data attribute.
6. Run `checkPostHogContract` from `@hraness/posthog/testing` in the application's required tests.
7. Run this repository's package gate before changing an export, privacy default, or peer range.

## Questions

### Why not configure `posthog-js` directly?

For page views alone, configure it directly: `posthog-js` has a
[cookieless mode](https://posthog.com/tutorials/cookieless-tracking). This package adds checks you
would otherwise write yourself: capture only on declared hosts, canonical route paths, rejection of
undeclared events, query filtering, credential and email redaction, repeat-limited server error
reports, and source-map upload for production builds.

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

Browser analytics uses the shared Accounts region policy. It starts before cookie acceptance when
Accounts explicitly returns `required: false`; required, unknown, malformed, or unavailable region
checks wait for acceptance. The check sends no credentials and times out after five seconds.
An existing refusal remains off. PostHog keeps memory-only cookieless state in either case.

The shared footer signals choices through `hraness-consent-accepted` and
`hraness-consent-declined`, including when local storage is unavailable. Declining immediately
blocks capture and aborts pending requests. Cross-tab changes to `hraness-consent-cookies-v1`
are honored.
Direct browser integrations use `observePostHogBrowser(options, ready)` to install listeners
when analytics becomes available and remove them on cleanup. `initializePostHogBrowser` returns
false while the shared policy is unresolved or blocked. Events from that time are discarded.

Conversions and event schemas remain owned by the consuming site. The shared regional
consent gate adds a collection boundary before browser analytics starts.

### Reuse consent with an existing analytics client

`@hraness/posthog/consent` has no provider or framework runtime imports. Existing browser
clients can preserve their own event limits and SDK configuration while sharing the Accounts
region policy:

```ts
import { getBrowserConsent, installConsentTransport } from "@hraness/posthog/consent";

const consent = getBrowserConsent();
const unsubscribe = consent?.subscribe(() => {
  if (consent.allowed() && installConsentTransport(posthog, consent)) startOrResumeAnalytics();
  else stopAnalytics();
});
```

Install this transport guard before initializing a custom PostHog provider. Set
`request_batching: false`; batching could retain events before their first transport
attempt, so the guard refuses transports while batching is enabled. It uses the pinned
provider's final request seam because its public cookieless opt-out cannot stop retries;
unknown provider/request shapes fail closed. PostHog.js **1.412.1 and 1.422.5** are
qualified; other versions are refused before initialization. Keep custom providers
pinned to one of these versions. PostHog.js 1.434.5 bypasses this request seam. The
package tests actual failed requests, withdrawal, reacceptance and page leaves;
browser verification covers both qualified versions.

Keep the consuming site's production-host and route checks. Initialize the provider only while
`consent.allowed()` is true, check it before every capture, and discard events from blocked
periods. Stop collection when the subscription reports refusal and call `unsubscribe` when
the consuming component is removed. On the server, `getBrowserConsent()` returns `undefined`.

### Which Next.js versions are verified?

The package accepts Next.js 16.2 through the 16.x line. Its package smoke test installs the packed
artifact into real Next.js 16.2.12 and 16.3.1 TypeScript-config consumers, then imports every public
entry point with Node.js 24 itself (not Bun).

## Reference

- [Site and route types](src/site.ts)
- [Event sanitization and budgets](src/event.ts)
- [Browser adapter](src/client.ts)
- [Shared browser consent](src/consent.ts)
- [Test harness](src/testing.ts)
- [Server adapter](src/server.ts)
- [Source-map adapter](src/next-config.ts)
- [Security policy](SECURITY.md)
- [Contribution and compatibility contract](CONTRIBUTING.md)

## Development

Use Bun 1.3.14 and Node.js 24. The aggregate gate verifies lint, types, bundle boundaries,
deterministic and property tests, a packed artifact in two Next.js
minors, portfolio inventory, public provenance, documentation contracts, and the knowledge base.

```sh
bun install --frozen-lockfile
bun run check
```

The package is available under the [MIT License](LICENSE).

Maintained by [Hraness](https://hraness.com).
