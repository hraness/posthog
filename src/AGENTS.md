# Contents

- `site.ts` normalizes hosts and paths, validates site-owned routes, and derives canonical route context.
- `event.ts` normalizes event properties, sanitizes provider payloads, redacts sensitive values, and bounds exception capture.
- `traffic.ts` classifies direct, internal, search, AI, social, and referral traffic from referrers and optional attribution.
- `client.ts` configures eligible PostHog.js browser capture and privacy-safe delegated DOM events.
- `react.tsx` installs browser capture through small client components.
- `server.ts` reports bounded request exceptions without affecting request behavior.
- `next-config.ts` enables production-only source-map upload.
- Test files prove deterministic examples, privacy regressions, and general sanitizer laws.

# Guidelines

- Keep product identities, routes, event semantics, and conversion definitions in consumers.
- Preserve fail-closed eligibility and event allowlists. An unavailable or invalid integration returns a no-op result.
- Sanitize every provider payload after route and token validation. Never weaken credential, email, URL query, referrer, or cyclic-object handling.
- Keep pure code free of provider, React, Next.js, browser, and Node runtime imports.
- Keep browser code free of Node and build-time imports. Keep server and source-map code out of browser exports.
- Add a readable regression for each behavior change and a property test when the behavior expresses a law over broad input.
