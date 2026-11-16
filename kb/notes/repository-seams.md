---
title: Repository seams
type: concept
tags:
  - architecture
  - dependencies
  - repositories
repository_scopes:
  - AGENTS.md
  - package.json
  - src
---

# Repository seams

This package owns the region policy, the shared event vocabulary, channel grouping and first-touch attribution, event cleaning, the PostHog browser client and its consent banner, the policy gate for the Meta Pixel and Conversions API, server capture and billing events, the app and CLI wire format, and opt-out CLI telemetry. A Swift package in `swift/` sends the same wire format from Mac and iOS apps. Consumers own their PostHog project and token, hosts, route patterns, product events, conversion meaning, privacy page, and interface composition.

The region table in `src/policy.ts` is the only source of region rules. The browser, the edge, the server, the CLI, and the generated Swift table read it, so a change to what a region allows lands everywhere at once. The table encodes the owner's 2026-11-16 decisions: the EU and EEA stay cookieless until a yes; the UK, Switzerland, and Brazil get analytics by default and a banner only for ads and recordings; the US and the rest of the world get everything with a "Your Privacy Choices" link; GPC turns off ads and replay only; Do Not Track is ignored.

The package currently declares no Hraness runtime dependency. Any future shared dependency must use a reviewed immutable release or full commit so consumers can upgrade independently. Do not connect development through sibling paths, Git submodules, or coordinated `main` workflows. Extract another shared package only after two concrete consumers need the same stable, product-neutral interface.

The public exports separate pure data from runtimes. Root, `./policy`, `./events`, and `./attribution` import nothing. `./browser` alone imports `posthog-js`, through its no-external-dependency entry points loaded lazily. `./meta` and `./server` use Web APIs only, so they run in Workers, edge functions, and Node. `./cli` alone imports Node built-ins. `scripts/check-bundle-boundaries.ts` enforces this on the built output.

This package stays headless. Consumer interfaces may layer accessible primitives and product-owned layout without coupling UI packages to analytics. The consent banner is the one rendered element; it uses plain DOM with product-supplied words.

Freeze schemas and export contracts before parallel lanes. Give the package manifest, export map, generated output, and lockfile one owner while independent lanes change disjoint implementation and test paths.

## Related

The normative rules remain in the root `AGENTS.md`. [[documentation-ownership|Documentation ownership]] explains how those rules relate to executable contracts and this pull-based context.
