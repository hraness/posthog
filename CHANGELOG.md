# Changelog

## 1.0.2

- Fixed: on private paths, the page title still went out as the plain `title` property of the first pageview. Every page title property is now dropped there.
- Fixed: on private paths, autocapture chains kept link addresses and attributes such as `aria-label`, `title`, `alt`, `name` and `value`. Only the element names, classes and the `data-ph` marker remain.
- Added: `cleanEvent` cleans a whole event and applies `allowProps` to its properties only, so a `clean.allowProps` list never removes the event's own fields.

## 1.0.1

- Fixed: page addresses used as property keys (heatmap data) kept their query string, fragment and any email in them. Keys are now cleaned like `$current_url`, entries that clean to the same page are merged, and `href` values in autocapture chains are cleaned too.

## 1.0.0

- First release as `@hraness/analytics`: one region policy for websites, Workers, command-line tools and Mac and iOS apps.
