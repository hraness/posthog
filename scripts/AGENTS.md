# Contents

- `build.ts` emits one externalized ESM bundle per public export.
- `check-bundle-boundaries.ts` proves runtime dependency isolation between pure, browser, React, Node, and build-time exports.
- `check-product-contract.ts` keeps the README, package manifest, public exports, fleet inventory, and immutable GitHub release boundary aligned.
- `check-public-boundary.ts` rejects private provenance and credential-like values.
- `package-smoke.ts` installs the packed artifact, imports every built export with genuine Node 24, checks source types, and builds real Next.js 16.2 and 16.3 TypeScript-config consumers.
- `check-portfolio-inventory.ts` derives and verifies the canonical public package inventory.

# Guidelines

- Keep verification deterministic, cross-platform where practical, and free of network writes beyond dependency installation.
- Derive fleet inventory from package metadata; never maintain a second hand-authored dependency graph.
- Verify the packed artifact rather than relying only on source imports.
- Exercise `next.config.ts` through each supported Next.js minor so conditional-export regressions fail before release.
- Update bundle allowlists only when an intentional public dependency boundary changes.
- Keep release mutation in the release workflow. Ordinary checks remain read-only.
