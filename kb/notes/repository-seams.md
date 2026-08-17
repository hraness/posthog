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

This package owns product-neutral site and event schemas, route normalization, provider-payload sanitization, privacy defaults, traffic attribution, bounded exception reporting, and production-only source-map configuration. Consumers own their domains, route taxonomies, event and conversion meaning, deployment environment, consent policy, and interface composition.

The package currently declares no Hraness runtime dependency. Any future shared dependency must use a reviewed immutable release or full commit so consumers can upgrade independently. Do not connect development through sibling paths, Git submodules, or coordinated `main` workflows. Extract another shared package only after two concrete consumers need the same stable, product-neutral interface.

The public exports separate pure data utilities from browser, React, Node, and build-time integrations. Root, `./site`, `./event`, and `./traffic` cannot import provider or framework runtimes. `./client` cannot import Node or build-time code. `./react` may add React to the browser surface. `./server` and `./next-config` stay outside browser dependency graphs.

This package stays headless. Consumer interfaces may layer accessible primitives and product-owned layout without coupling UI packages to analytics. Direct compositions are development-only and must never enter published exports or production dependency graphs.

Freeze schemas and export contracts before parallel lanes. Give the package manifest, export map, generated output, and lockfile one owner while independent lanes change disjoint implementation and test paths.

## Related

The normative rules remain in the root `AGENTS.md`. [[documentation-ownership|Documentation ownership]] explains how those rules relate to executable contracts and this pull-based context.
