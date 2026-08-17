# Contents

- `build.ts` emits one externalized ESM bundle per public export.
- `check-bundle-boundaries.ts` proves runtime dependency isolation between pure, browser, React, Node, and build-time exports.
- `check-public-boundary.ts` rejects private provenance and credential-like values.
- `package-smoke.ts` installs the packed artifact, imports every built export with Node 24, and checks source types from a consumer.

# Guidelines

- Keep verification deterministic, cross-platform where practical, and free of network writes beyond dependency installation.
- Verify the packed artifact rather than relying only on source imports.
- Update bundle allowlists only when an intentional public dependency boundary changes.
- Keep release mutation in the release workflow. Ordinary checks remain read-only.
