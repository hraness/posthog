<!-- kb:context scopes/repository--cdb4ee2aea69 -->
# Contents

- `src/site.ts`, `src/event.ts`, and `src/traffic.ts` define provider-neutral schemas, routing, sanitization, privacy, and attribution.
- `src/client.ts` and `src/react.tsx` own browser and React integration with PostHog.js.
- `src/server.ts` owns bounded server exception reporting through PostHog Node.
- `src/next-config.ts` owns production-only source-map configuration.
- `src/*.test.ts` and `src/*.property.test.ts` hold deterministic regressions and general laws.
- `scripts/` builds isolated exports and verifies package, bundle, and public boundaries.
- `portfolio-inventory.json` records the package publication boundary in the shared fleet contract.
- `.github/workflows/` runs read-only continuous integration and publishes only a verified immutable release.
- `.agents/skills/` contains the portable knowledge workflows and five-skill phased-execution pack.
- `kb/` contains authored repository rationale, maintained synthesis, and implementation plans.
- `WRITING.md` and `STYLE.md` define the internal and public prose contracts.

# Guidelines

- Keep this package product-neutral. Consumers own site definitions, route taxonomies, conversion meaning, deployment configuration, and UI composition.
- Follow `WRITING.md` for internal prose and `STYLE.md` for public prose.
- Apply unreasonably robust programming when agent work is cheap. Parse foreign values from `unknown`, model invalid states out of existence, and pair deterministic regressions with property tests for parsers, sanitizers, budgets, routing, and attribution.
- Deliver changes to `main` through a current-head pull request. Keep the stable `Required` CI job green, resolve every review thread, and serialize merges. Human approval stays optional while one regular maintainer would otherwise self-review. Never force-push or bypass the gate.
- Pin Hraness dependencies to reviewed immutable releases or full commits. Never connect repositories through sibling paths, Git submodules, or coordinated `main` assumptions; upgrade consumers independently.
- Preserve the export boundaries. The root and `./site` exports stay provider-neutral; `./client` is browser-only; `./react` adds React; `./server` is Node-only; and `./next-config` is build-time-only.
- Never send analytics outside production, from an unapproved host, without a valid public project token, or for an event outside the site allowlist.
- Preserve memory-only cookieless analytics, anonymous profiles, disabled autocapture and recording, URL/query redaction, bounded exception capture, and no-op failure behavior.
- Treat source-map credentials as build-time secrets. Upload only for an exact production deployment with a supported PostHog UI host and a commit release identifier.
- Keep Direct deterministic compositions development-only and outside every production dependency graph and published export.
- Freeze package interfaces before parallel lanes begin. Give exports, manifests, lockfiles, generated output, and other convergence surfaces one owner while lanes edit disjoint paths.
- Keep `portfolio-inventory.json` generated from `package.json`; the checked inventory must match the public package name, version, repository, and Hraness dependency edges exactly.
- Keep mandatory rules in the closest `AGENTS.md`, executable contracts in types and tests, and pull-based rationale, evidence, synthesis, and plans in `kb/`.
- Use Bun 1.3.14 for installs, builds, and tests. Verify every installed export with genuine Node 24, including the `./next-config` fallback used by supported Next.js TypeScript config loaders.
- Run `bun run check` before release handoff. The release workflow may write only the verified immutable GitHub Release.

<!-- hra-local-efficiency:start -->
- Preserve useful agent fan-out. Give each expensive focused validation command and external wait one owner; the integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate. On Hraness development machines, use `$hra-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available.
<!-- hra-local-efficiency:end -->
