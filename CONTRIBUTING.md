# Contributing

Open an issue before proposing a behavior or identity change. Site schemas, event filtering, privacy defaults, export boundaries, and source-map environment names are compatibility contracts.

Use Bun 1.3.14 and Node 24. Install dependencies and run the complete local gate:

```sh
bun install --frozen-lockfile
bun run check
```

Add a deterministic regression test for every behavior change and a property test for general laws. Keep examples product-neutral and never add credentials, private repository names, live analytics URLs, or customer data.
