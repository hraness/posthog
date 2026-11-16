// src/events.ts
var SCHEMA = 2;
var MARKETING_EVENTS = [
  "cta clicked",
  "outbound link opened",
  "demo played",
  "download started",
  "install command copied",
  "store link opened",
  "download link emailed",
  "download link failed",
  "analytics choice made"
];
var LIFECYCLE_EVENTS = [
  "app installed",
  "app opened",
  "cli command run",
  "mcp tool called",
  "account created",
  "signed in",
  "activated",
  "upgrade offered",
  "checkout started"
];
var SERVER_EVENTS = [
  "download served",
  "checkout completed",
  "subscription started",
  "subscription renewed",
  "subscription canceled",
  "payment failed",
  "refund issued",
  "checkout session created"
];
var SHARED_EVENTS = [...MARKETING_EVENTS, ...LIFECYCLE_EVENTS, ...SERVER_EVENTS];
var MILESTONES = [1, 3, 10, 30, 100];
function daysBucket(days) {
  if (!Number.isFinite(days) || days < 1)
    return "0";
  if (days < 2)
    return "1";
  if (days < 7)
    return "2-6";
  if (days < 30)
    return "7-29";
  return "30+";
}
function durationBucket(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000)
    return "<1s";
  if (milliseconds < 5000)
    return "1-5s";
  if (milliseconds < 30000)
    return "5-30s";
  return "30s+";
}
function isEventName(value) {
  return typeof value === "string" && (/^[a-z][a-z0-9]*(?: [a-z0-9]+){0,5}$/u.test(value) || /^\$[a-z_]{2,40}$/u.test(value));
}
export {
  isEventName,
  durationBucket,
  daysBucket,
  SHARED_EVENTS,
  SERVER_EVENTS,
  SCHEMA,
  MILESTONES,
  MARKETING_EVENTS,
  LIFECYCLE_EVENTS
};

//# debugId=9BE17E5F584DE14264756E2164756E21
