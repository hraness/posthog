/**
 * The shared event taxonomy. Names are object then verb, lower case, past tense, with spaces. Property keys are
 * snake_case and values are bounded labels. A misspelled shared event fails `tsc`; a product adds its own events
 * through the `Extra` type parameter of the browser, server and CLI clients.
 */

/** Bumped when an event's meaning changes, so old and new are never added together. */
export const SCHEMA = 2;

export type Surface = "site" | "docs" | "web_app" | "account" | "mac" | "ios" | "cli" | "mcp" | "extension" | "server";
export type Placement = "nav" | "hero" | "inline" | "footer" | "sticky" | (string & {});
export type Platform = "mac" | "windows" | "linux" | "ios" | "web";

/** Acquisition and marketing events, sent from the browser. */
export const MARKETING_EVENTS = [
  "cta clicked",
  "outbound link opened",
  "demo played",
  "download started",
  "install command copied",
  "store link opened",
  "download link emailed",
  "download link failed",
  "analytics choice made",
] as const;

/** Lifecycle events, from any client. */
export const LIFECYCLE_EVENTS = [
  "app installed",
  "app opened",
  "cli command run",
  "mcp tool called",
  "account created",
  "signed in",
  "activated",
  "upgrade offered",
  "checkout started",
] as const;

/** Events only a server sends: downloads it served and billing it saw. */
export const SERVER_EVENTS = [
  "download served",
  "checkout completed",
  "subscription started",
  "subscription renewed",
  "subscription canceled",
  "payment failed",
  "refund issued",
  "checkout session created",
] as const;

export const SHARED_EVENTS = [...MARKETING_EVENTS, ...LIFECYCLE_EVENTS, ...SERVER_EVENTS] as const;

export type MarketingEvent = (typeof MARKETING_EVENTS)[number];
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];
export type ServerEvent = (typeof SERVER_EVENTS)[number];
export type SharedEvent = (typeof SHARED_EVENTS)[number];
/** A shared event or one of the product's own (`Extra`). */
export type EventName<Extra extends string = never> = SharedEvent | Extra;

/** A property value: a bounded label, a number or a flag. Never an object, a sentence or an address. */
export type PropValue = string | number | boolean | null | undefined;
export type Props = Readonly<Record<string, PropValue>>;

/** Properties the shared events carry, where the taxonomy fixes them. Other events take any `Props`. */
export type SharedProps = {
  "cta clicked": { cta: string; placement: Placement };
  "outbound link opened": { target_host: string; placement: Placement };
  "demo played": { demo: string; placement?: Placement };
  "download started": { platform: Platform; artifact: "zip" | "dmg" | "pkg" | "script"; placement: Placement };
  "download served": { platform: Platform; artifact: "zip" | "dmg" | "pkg" | "script"; version?: string; ref?: string };
  "install command copied": { method: "npm" | "brew" | "curl" | "cargo" | "bun" };
  "store link opened": { store: "app_store" | "mac_app_store" | "chrome_web_store" };
  "download link emailed": { platform: Platform; placement?: Placement };
  "download link failed": { platform: Platform };
  "analytics choice made": { choice: "yes" | "no"; scope: "all" | "ads" | "recordings" };
  "app installed": { platform: Platform; channel: "direct" | "app_store" | "npm" | "brew"; ref?: string };
  "app opened": { platform: Platform; days_since_install_bucket: DaysBucket };
  "cli command run": { command: string; ok: boolean; duration_bucket: DurationBucket; ci: boolean };
  "mcp tool called": { tool: string; client: "claude" | "cursor" | "codex" | "other"; ok: boolean };
  "account created": { method: "email" | "apple" | "google"; surface: Surface };
  "signed in": { method: "email" | "apple" | "google" };
  activated: { milestone: string };
  "upgrade offered": { placement: Placement; reason: string };
  "checkout started": { plan: string; interval: Interval; store: Store };
  "checkout completed": BillingProps;
  "subscription started": BillingProps;
  "subscription renewed": BillingProps;
  "subscription canceled": BillingProps & { at_period_end?: boolean };
  "payment failed": BillingProps;
  "refund issued": BillingProps & { full?: boolean };
  "checkout session created": BillingProps;
};

export type Interval = "day" | "week" | "month" | "year";
export type Store = "stripe" | "app_store" | "mac_app_store";
export type BillingProps = {
  plan?: string;
  interval?: Interval;
  store: Store;
  amount?: number;
  currency?: string;
  first_ref?: string;
  first_source?: string;
  livemode: boolean;
};
export type DaysBucket = "0" | "1" | "2-6" | "7-29" | "30+";
export type DurationBucket = "<1s" | "1-5s" | "5-30s" | "30s+";

/** The properties an event takes: the taxonomy's for a shared event, otherwise any bounded `Props`. */
export type PropsOf<E extends string> = E extends keyof SharedProps ? SharedProps[E] & Props : Props;

/** Properties every event carries (registered once per page, app or process). */
export type SuperProps = {
  site_id: string;
  surface: Surface;
  schema: number;
  page_kind?: string;
  app_version?: string;
  consent_mode?: "persistent" | "cookieless";
  region_group?: "eu" | "uk_ch" | "br" | "us" | "row";
};

/** Activation milestones are reported at these counts only (the 1st, 3rd, 10th...). */
export const MILESTONES: readonly number[] = [1, 3, 10, 30, 100];

export function daysBucket(days: number): DaysBucket {
  if (!Number.isFinite(days) || days < 1) return "0";
  if (days < 2) return "1";
  if (days < 7) return "2-6";
  if (days < 30) return "7-29";
  return "30+";
}

export function durationBucket(milliseconds: number): DurationBucket {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return "<1s";
  if (milliseconds < 5000) return "1-5s";
  if (milliseconds < 30_000) return "5-30s";
  return "30s+";
}

/** Whether a name follows the taxonomy's form: lower case words with spaces, or a PostHog `$` event. */
export function isEventName(value: unknown): value is string {
  return typeof value === "string" && (/^[a-z][a-z0-9]*(?: [a-z0-9]+){0,5}$/u.test(value) || /^\$[a-z_]{2,40}$/u.test(value));
}
