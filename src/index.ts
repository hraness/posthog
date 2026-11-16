/**
 * The provider-neutral core: region policy, the shared event taxonomy and arrival attribution. Safe in a browser,
 * an edge Worker, Node and a build script. The PostHog, Meta, server and CLI helpers are separate entries.
 */
export * from "./attribution.ts";
export * from "./events.ts";
export * from "./policy.ts";
