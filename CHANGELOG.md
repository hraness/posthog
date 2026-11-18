# Changelog

## 1.1.0

- Added: `@hraness/analytics/experiment`, local A/B assignment that runs before the client loads. `assign` hashes the experiment key with the stored first-party ID, falls back to a per-page ID without storing anything, takes optional weights and a `?exp-<key>=<variant>` QA override. `experimentScript` returns an inline `<head>` script that sets `data-exp-<key>` on `<html>` before the first paint.
- Added: `expose(assignment)` on the browser client. Each experiment is reported once per page as `$feature_flag_called` with `$feature_flag` and `$feature_flag_response`, and `$feature/<key>` rides on every later event, so PostHog Experiments reads it with no flag evaluation. Assignments made before `createAnalytics` are reported without a call, and exposures are sent again after a European yes changes the distinct ID.
- Changed: when persistent analytics starts with no stored ID, the client adopts the ID an experiment on the page used, so the variant holds on the next page.

## 1.0.3

- Fixed: `first_landing` kept the address a visitor arrived at, which could name a private item. A landing that matches `privatePaths` or `clean.routes` is now kept as its route pattern, and a first-touch record saved by an earlier version is reduced when it is read.
- Fixed: a later yes could not undo an earlier no. Answers now carry the time they were made, and the latest answer wins for each of analytics and ads. Copies saved at the same moment, or before this version, still let a no win.
- Fixed: `first_referrer_host` was emptied when events were cleaned. It now keeps the host.
- Added: `snapshotArrival()` and `ARRIVAL_SCRIPT` take the landing path, query and referrer at load, so `createAnalytics` can be imported later without losing them.
- Added: `rateLimit` and `clientAddress` for the server. `wireHandler` takes optional per-address and per-install limits, and `downloadServed` an optional per-key limit. Both are off unless passed.

## 1.0.2

- Fixed: on private paths, the page title still went out as the plain `title` property of the first pageview. Every page title property is now dropped there.
- Fixed: on private paths, autocapture chains kept link addresses and attributes such as `aria-label`, `title`, `alt`, `name` and `value`. Only the element names, classes and the `data-ph` marker remain.
- Added: `cleanEvent` cleans a whole event and applies `allowProps` to its properties only, so a `clean.allowProps` list never removes the event's own fields.

## 1.0.1

- Fixed: page addresses used as property keys (heatmap data) kept their query string, fragment and any email in them. Keys are now cleaned like `$current_url`, entries that clean to the same page are merged, and `href` values in autocapture chains are cleaned too.

## 1.0.0

- First release as `@hraness/analytics`: one region policy for websites, Workers, command-line tools and Mac and iOS apps.
