# Changelog

## 1.0.1

- Fixed: page addresses used as property keys (heatmap data) kept their query string, fragment and any email in them. Keys are now cleaned like `$current_url`, entries that clean to the same page are merged, and `href` values in autocapture chains are cleaned too.

## 1.0.0

- First release as `@hraness/analytics`: one region policy for websites, Workers, command-line tools and Mac and iOS apps.
