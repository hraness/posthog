# @hraness/analytics

[![CI](https://img.shields.io/github/actions/workflow/status/hraness/posthog/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/hraness/posthog/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hraness/posthog?style=flat-square&label=release)](https://github.com/hraness/posthog/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/hraness/posthog?style=flat-square)](LICENSE)

## One analytics standard for every surface

`@hraness/analytics` applies one PostHog setup to websites, documentation, web apps, Workers, command-line tools
and Mac apps. Each surface reads the same region table, so a visitor in Germany, London or Chicago gets the same
treatment on the site, in the app and in the CLI.

The package covers:

- a region policy that decides what may run before and after a visitor answers;
- a browser client with presets for marketing pages, docs and apps, a consent banner and first-touch attribution;
- a Meta Pixel and Conversions API layer that runs only where the policy allows ads;
- server capture, Stripe billing events and an endpoint for app and CLI telemetry;
- CLI telemetry that is on by default outside Europe, with a first-run notice, `DO_NOT_TRACK` and an off command;
- a Swift package for Mac and iOS apps that sends the same wire format.

Your product still owns its PostHog project, its token, its own events and its privacy page.

## The region table

The edge's country header decides the region. The browser's time zone is used only when the country is missing,
and a visitor whose region cannot be told is treated as European.

| Region | Analytics | Autocapture and heatmaps | Replay | Meta ads | Banner asks |
| --- | --- | --- | --- | --- | --- |
| EU, EEA and unknown | cookieless | off | off | off | all |
| UK and Switzerland | persistent | on | off | off | ads |
| Brazil | persistent | on | off | off | ads |
| United States | persistent | on | on | on | none |
| Rest of the world | persistent | on | on | on | none |

- **Cookieless** keeps nothing on the device. **Persistent** keeps a first-party ID for up to 13 months.
- In Europe one question covers everything. A yes turns on persistent analytics, autocapture, replay and ads.
- In the UK, Switzerland and Brazil the banner asks only about ads and recordings.
- In the US and the rest of the world there is no banner. A "Your Privacy Choices" link turns off ads and replay.
- Global Privacy Control turns off ads and replay in every region and changes nothing else. Do Not Track is ignored.
- An analytics no makes the visit cookieless with nothing extra, in every region.
- Replay and heatmaps never run on the `app` preset or on paths you mark private, whatever the region allows.

The table lives in [`src/policy.ts`](src/policy.ts) and is generated into the Swift package, so both clients agree.

## Install

This repository does not publish the package to npm. Pin the immutable GitHub Release tarball:

```json
{
  "dependencies": {
    "@hraness/analytics": "https://github.com/hraness/posthog/releases/download/v1.1.0/hraness-analytics-1.1.0.tgz"
  }
}
```

Each release also carries a `SHA256SUMS` file. The package needs Node 24 or later on the server and pins
`posthog-js` 1.449.1 for the browser.

For a Mac or iOS app, add the repository as a Swift package from the `v1.1.0` tag:

```swift
.package(url: "https://github.com/hraness/posthog.git", from: "1.1.0")
```

The Swift package ([`Package.swift`](Package.swift)) depends only on Foundation, plus AppKit for the consent sheet.

## Exports

| Import | Runs in | What it holds |
| --- | --- | --- |
| `@hraness/analytics` | anywhere | The policy, event and attribution modules together. |
| `@hraness/analytics/policy` | anywhere | `regionPolicy`, `regionGroup`, `policyForGroup`, `REGION_TABLE`, `telemetryDefault`, `regionResponse`, `parseRegionResponse`. |
| `@hraness/analytics/events` | anywhere | The shared event names and their property types, `daysBucket`, `durationBucket`, `MILESTONES`. |
| `@hraness/analytics/attribution` | anywhere | `channelOf`, `refLabel`, `remember`, `firstTouchProps`, `withoutTracking`, `carryRef`, `cleanUrl`, `cleanProps`. |
| `@hraness/analytics/browser` | browser | `createAnalytics` and the option helpers it uses. |
| `@hraness/analytics/experiment` | browser, before the client | `assign`, `experimentScript`, and the `Experiment` and `Assignment` types. No imports. |
| `@hraness/analytics/meta` | browser and server | `startPixel`, `adsAllowed`, `trackForServer`, `capiEvent`, `sendCapi`, `hashEmail`, `readAds`. |
| `@hraness/analytics/server` | Workers, edge, Node | `regionHandler`, `capture`, `accountDistinctId`, `captureBilling`, `wireHandler`, `downloadServed`, `deletePerson`. |
| `@hraness/analytics/cli` | Node | `createTelemetry`. |

Only `./browser` imports `posthog-js`, and it loads the SDK lazily without external scripts. Only `./cli` imports
Node built-ins. Every other export uses Web APIs only.

## Websites, docs and web apps

Serve the region from your edge, then start the client on each page:

```ts
// The region endpoint, for example app/api/region/route.ts or a Worker route.
import { regionHandler } from "@hraness/analytics/server";
export const GET = (request: Request) => regionHandler(request);
```

```ts
import { createAnalytics } from "@hraness/analytics/browser";

const analytics = createAnalytics<"export completed">({
  token: process.env.NEXT_PUBLIC_POSTHOG_TOKEN ?? "",
  hosts: ["example.com", "www.example.com"],
  siteId: "example",
  preset: "marketing",
  privatePaths: ["/account", "/s/*"],
  privacyHref: "/privacy",
});

analytics.track("cta clicked", { cta: "download", placement: "hero" });
```

To load the client later than the page (a dynamic `import()` after the router has started), take the arrival
snapshot first. Call `snapshotArrival()` from `@hraness/analytics/attribution` in the page's first module, or put
`ARRIVAL_SCRIPT` in an inline `<head>` script. It keeps the landing path, query and referrer as the page first saw
them, so a router that rewrites the address before `createAnalytics` runs does not lose the visit's UTMs, `ref` tag
or referrer.

`createAnalytics` returns a client that does nothing when the token is empty, the host is not listed, or the page
runs inside a native shell. Its methods:

- `track(event, props)` and `trackNth(event, props)` report an event. `trackNth` adds `nth` on the 1st, 3rd, 10th,
  30th and 100th time on a page.
- `describe(props)` adds facts, such as `plan`, to every later event on the page.
- `identify(accountId, person)` links the browser to a signed-in account. Pass an opaque ID, such as the result of
  `accountDistinctId` on your server, never an email. It works only in persistent mode.
- `reset()` gives the browser a new anonymous ID on sign-out. The first-touch record stays.
- `choose(scope, choice)` records the banner's or a settings toggle's answer.
- `privacyChoices()` is the handler for the "Your Privacy Choices" link.
- `distinctId()`, `firstRef()` and `carry()` return what to hand to checkout or a download link.
- `expose(assignment)` reports an experiment variant the page showed. See [Experiments](#experiments).
- `policy()` and `counting()` report what the page is allowed to do.

### Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | The PostHog project's public token. Empty turns everything off. |
| `hosts` | required | Hosts the client may run on, matched exactly. |
| `siteId` | required | Sent as `site_id` on every event. |
| `preset` | required | `marketing`, `docs` or `app`. The `app` preset never records or draws heatmaps, captures only clicks on `button`, `a` and `[data-ph]`, and masks all text. |
| `apiHost` | `/ph` | Same-origin proxy path or URL for PostHog. |
| `uiHost` | none | PostHog's app host, for toolbar links. |
| `surface` | from the preset | Sent as `surface`. |
| `pageKind` | none | Sent as `page_kind`. |
| `storagePrefix` | `siteId` | Prefix for the first-party cookie and storage keys. |
| `regionUrl` | `/api/region` | Where the region comes from. `false` uses the time zone alone. An edge can also inject `window.__hranessRegion`. |
| `contentParams` | none | Query parameters that change what a page shows, recorded as `first_<name>`. |
| `landingKind` | none | Maps the landing path to `first_landing_kind`. It receives the path's route pattern when the path matches `privatePaths` or `clean.routes`. |
| `channel` | none | Your own hosts and extra `ref` tags for channel grouping. |
| `privatePaths` | none | Route patterns where replay and heatmaps never run and only allowlisted clicks are captured. |
| `privateSelector` | `[data-private], .ph-no-capture` | Elements whose text replay masks and whose clicks are dropped. |
| `clean` | none | Route patterns and allowed properties for cleaning events before they leave the page. |
| `replaySampleRate` | project setting | Share of eligible sessions recorded, from 0 to 1. |
| `native` | none | Returns true inside a native app shell, where nothing runs. |
| `words` | English | The banner's text. |
| `privacyHref` | none | Link to your privacy page from the banner. |
| `onAds` / `onAdsOff` | none | Called when ads become allowed and when they must stop. Start the Meta Pixel here with `startPixel(browserPage(href), ...)`, where `href` is the page address with launch tags cut. |
| `askDelayMs` | `2500` | Delay before the banner appears. |

### Experiments

`@hraness/analytics/experiment` picks an A/B variant while the page draws, before the client loads, and the client
reports it in the form PostHog Experiments reads. Assignment is local: no PostHog feature flag is evaluated and the
page makes no extra request. The module has no imports, and `assign` is about 2 KB once minified, so it fits in a
page's first script. Its source is [`src/experiment.ts`](src/experiment.ts).

```ts
import { assign } from "@hraness/analytics/experiment";

const HEADER_CTA = { key: "header-cta", variants: ["control", "free"] } as const;
const { variant } = assign(HEADER_CTA, { siteId: "example" });
document.documentElement.dataset.expHeaderCta = variant;
```

On a server-rendered page, render every variant and let CSS choose. `experimentScript(experiments, site)` returns an
inline `<head>` script that sets `data-exp-<key>="<variant>"` on `<html>` before the first paint:

```tsx
<script dangerouslySetInnerHTML={{ __html: experimentScript([HEADER_CTA], { siteId: "example" }) }} />
// CSS: html:not([data-exp-header-cta="free"]) .cta-free, html[data-exp-header-cta="free"] .cta-control { display: none }
```

How a variant is chosen:

- The variant is a hash of the experiment key and the visitor's first-party ID, the one `createAnalytics` keeps in
  persistent mode. A returning visitor sees the same variant on every page.
- A visitor with no stored ID, or one who answered no to analytics, gets a variant for this page only, from a random
  ID held in memory. Nothing is written. If the client then starts persistent analytics, it adopts that ID, so the
  next page shows the same variant. A cookieless visitor (in Europe, before a yes) can see a different variant on each
  page, and PostHog leaves visitors exposed to two variants out of the results by default. Expect that noise in
  European traffic.
- `weights` sets each variant's share, one non-negative number per variant. Without it the split is equal.
- `?exp-<key>=<variant>` forces a variant for QA. A forced variant is never reported, and the query parameter never
  reaches PostHog because cleaned addresses keep only `utm_*`, `ref` and `via`.
- Pass the same `siteId` (and `storagePrefix`, if you set one) as `createAnalytics`, so both read the same ID.
- Keys and variants use lower-case letters, digits, `-` and `_`. An invalid experiment, or a call outside a browser,
  returns the first variant with source `fallback`, which is never reported.

`createAnalytics` reports every assignment made on the page before it started. Call `analytics.expose(assignment)`
for one made later. Each experiment is reported once per page: `$feature/<key>` is added to every later event, and one
`$feature_flag_called` event carries `$feature_flag` (the key) and `$feature_flag_response` (the variant). After a
European yes the visitor has a new distinct ID, and the client sends the exposure again under it. That event
is PostHog's default exposure, so create the experiment in PostHog with the same key and variant names, the first
variant named `control`, and leave the exposure criteria at their default. The package never asks PostHog to evaluate
the experiment's flag.

### What leaves the page

- Click IDs (`gclid`, `fbclid`, `msclkid`) are removed from every event. Emails are replaced with `[email]`.
  Referrers are reduced to their origin. Only `utm_*`, `ref` and `via` survive in a URL, as lower-case labels.
- After the first page view, tracking parameters are removed from the address bar.
- The first visit is kept as a first-touch record and sent as `first_ref`, `first_source`, `first_channel`,
  `first_landing` and related properties. A landing on a path that matches `privatePaths` or `clean.routes` is
  kept as its pattern (`/library/items/:id`), never the address itself.
- A later answer to the banner, a settings toggle or a privacy-page link replaces an earlier one, yes or no.
- Channels include `ai` (ChatGPT, Claude, Perplexity and others) and `community` (Hacker News, Reddit, Product Hunt,
  Lobsters and `ref` tags you register), alongside search, social, paid, email, referral and direct.

The rules live in [`src/attribution.ts`](src/attribution.ts), and the event vocabulary in [`src/events.ts`](src/events.ts).
The browser client is [`src/browser.ts`](src/browser.ts).

## Meta Pixel and Conversions API

[`src/meta.ts`](src/meta.ts) loads the Pixel only after `adsAllowed` says yes, with automatic events and remote
configuration off. Custom events go out at most once a day per browser. `trackForServer` returns an event ID and the
`_fbp` and `_fbc` values so your server can send the same event through the Conversions API with `sendCapi`. Emails
are normalized and hashed with SHA-256 before they leave your server. A missing token, a timeout or a Meta error
never throws.

## Servers and Workers

[`src/server.ts`](src/server.ts) provides:

- `capture(config, event, waitUntil)` sends one event with a stable UUID, no IP address and GeoIP lookup off.
  `ServerConfig` takes `token`, `siteId`, `host` (default `https://us.i.posthog.com`), `timeoutMs` and `fetch`.
- `accountDistinctId(secret, accountId)` returns `acct_` plus an HMAC of the account ID. Use it for `identify` in the
  browser and for billing events, so revenue joins the same person.
- `captureBilling(config, stripeEvent, { resolve })` turns Stripe webhooks into `checkout completed`,
  `subscription started`, `subscription renewed`, `subscription canceled`, `payment failed` and `refund issued`, with
  the first-touch labels you stored in checkout metadata with `checkoutMetadata`.
- `wireHandler(config, request, events, waitUntil, limits)` accepts batches from the CLI and the Swift package, rejects
  any event or property outside the allowlist, and identifies each install by a hash, never the raw install ID.
- `downloadServed(config, input, waitUntil, limit)` records a download with its `ref` tag. `deletePerson` erases a
  person and their events.

Rate limits are off unless you pass them. `rateLimit({ limit, windowMs, maxKeys })` counts uses per key in a fixed
window, by default 60 a minute for each key and at most 10,000 keys in memory. The count lives in one process, such as
a single Worker isolate, so it stops one noisy client rather than a distributed flood.

```ts
import { clientAddress, downloadServed, rateLimit, wireHandler } from "@hraness/analytics/server";

const limits = { perAddress: rateLimit({ limit: 120 }), perInstall: rateLimit({ limit: 60 }) };
export const POST = (request: Request) => wireHandler(config, request, {}, undefined, limits);

const downloads = rateLimit({ limit: 10 });
void downloadServed(config, { platform: "mac", artifact: "dmg" }, undefined, { rate: downloads, key: clientAddress(request) });
```

- `perAddress` answers `429` with `Retry-After` once an address passes its limit, before reading the body. The
  address comes from `cf-connecting-ip`, `x-real-ip` or the first `x-forwarded-for` entry.
- `perInstall` drops events past an install's limit, and answers `429` when nothing in the batch is left. The Swift
  package keeps a refused batch and sends it later. The CLI drops it.
- A download over its key's limit is still served. It just isn't counted.

## Command-line tools

[`src/cli.ts`](src/cli.ts) sends anonymous usage events from a CLI:

```ts
import { createTelemetry } from "@hraness/analytics/cli";

const telemetry = createTelemetry({
  siteId: "example",
  endpoint: "https://example.com/api/cli/event",
  envPrefix: "EXAMPLE",
  version: "1.4.0",
  configDir: `${process.env.HOME}/.config/example`,
  name: "Example",
  offCommand: "example telemetry off",
  onCommand: "example telemetry on",
  privacyUrl: "https://example.com/privacy",
});

await telemetry.time("publish", () => publish());
await telemetry.flush();
```

- Outside Europe telemetry is on by default and prints a notice once, on the first run.
- In Europe it prints the notice and stays off until the user runs the on command.
- `DO_NOT_TRACK=1` or `EXAMPLE_TELEMETRY_DISABLED=1` turns it off without writing anything. CI runs are skipped
  unless `EXAMPLE_TELEMETRY=1` is set.
- Events carry the command name, outcome and a duration bucket. They never carry arguments, paths or file contents.
- Sending waits at most one second and never fails the command.

## Mac and iOS apps

The Swift package sends the same wire format to `wireHandler`. `UsageAnalytics` keeps an install ID and a queue in
`UserDefaults`, asks first in Europe with `askIfNeeded`, and reports `app installed` (with the download's `ref` tag,
read from the file's download origin by `DownloadOrigin`) and `app opened`.

## Develop

```sh
bun install
bun run check
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
```

`bun run check` runs lint, type checks, unit and property tests, the build, bundle boundary checks and an installed
package smoke test under Node 24. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
