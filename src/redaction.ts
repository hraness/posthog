// Decode only an inspection shadow. Output retains original bytes outside
// sensitive spans, including reserved path separators and malformed escapes.
const MAX_INSPECTION_LENGTH = 32_768;
const MAX_DECODE_PASSES = 8;
type Span = Readonly<{ start: number; end: number }>;

function percentCharacter(value: string, index: number): Readonly<{ text: string; length: number }> | null {
  const first = value.slice(index, index + 3);
  if (!/^%[0-9a-f]{2}$/iu.test(first)) return null;
  const byte = Number.parseInt(first.slice(1), 16);
  const count = byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
  if (!count) return null;
  const encoded = value.slice(index, index + count * 3);
  if (!/^(?:%[0-9a-f]{2})+$/iu.test(encoded) || encoded.length !== count * 3) return null;
  try {
    return { text: decodeURIComponent(encoded), length: encoded.length };
  } catch {
    return null;
  }
}

function emailSpans(value: string): Span[] {
  const result: Span[] = [];
  const domain = /@[\p{L}\p{N}\p{M}.-]+\.[\p{L}\p{M}]{2,}/uy;
  let previousAt = -1;
  let previousEnd = 0;
  for (let at = value.indexOf("@"); at >= 0; at = value.indexOf("@", at + 1)) {
    let start = at;
    const floor = Math.max(previousAt + 1, previousEnd);
    while (start > floor) {
      const unit = value.charCodeAt(start - 1);
      const width = unit >= 0xdc00 && unit <= 0xdfff && start - 2 >= floor ? 2 : 1;
      if (!/^[\p{L}\p{N}\p{M}._%+-]+$/u.test(value.slice(start - width, start))) break;
      start -= width;
    }
    // Preserve punctuation separating neighboring email addresses.
    while (start < at && /^[._%+-]$/u.test(value.charAt(start))) start += 1;
    previousAt = at;
    if (start === at) continue;
    domain.lastIndex = at;
    const match = domain.exec(value);
    if (!match) continue;
    const end = at + match[0].length;
    result.push({ start, end });
    previousEnd = end;
  }
  return result;
}

function userinfoSpans(value: string): Span[] {
  const result: Span[] = [];
  for (let colon = value.indexOf("://"); colon >= 0; colon = value.indexOf("://", colon + 3)) {
    let scheme = colon;
    while (scheme > 0 && /^[a-z0-9+.-]$/iu.test(value.charAt(scheme - 1))) scheme -= 1;
    while (scheme < colon && !/^[a-z]$/iu.test(value.charAt(scheme))) scheme += 1;
    if (scheme === colon) continue;
    const start = colon + 3;
    let end = start;
    let at = -1;
    while (end < value.length && !/[/\s?#]/u.test(value.charAt(end))) {
      if (value.charAt(end) === "@") at = end;
      end += 1;
    }
    if (at > start) result.push({ start, end: at });
  }
  return result;
}

function redactEncodedIdentifiers(value: string): string {
  let shadow = value;
  let spans: Span[] = Array.from({ length: value.length }, (_, index) => ({ start: index, end: index + 1 }));
  const spanAt = (index: number): Span => spans[index] ?? { start: 0, end: value.length };
  for (let pass = 0; pass < MAX_DECODE_PASSES && shadow.includes("%"); pass += 1) {
    let decoded = "";
    const decodedSpans: Span[] = [];
    let changed = false;
    for (let index = 0; index < shadow.length; index += 1) {
      const escape = percentCharacter(shadow, index);
      if (escape) {
        decoded += escape.text;
        const span = { start: spanAt(index).start, end: spanAt(index + escape.length - 1).end };
        for (let unit = 0; unit < escape.text.length; unit += 1) decodedSpans.push(span);
        index += escape.length - 1;
        changed = true;
      } else {
        decoded += shadow.charAt(index);
        decodedSpans.push(spanAt(index));
      }
    }
    shadow = decoded;
    spans = decodedSpans;
    if (!changed) break;
  }
  const replacements: (Span & { replacement: string; priority: number })[] = [];
  // A capped nested escape remains ambiguous. Drop its original segment,
  // preserving the literal separators around it rather than allowing a leak.
  const unresolvedSpans = Array.from(shadow.matchAll(/%[0-9a-f]{2}/giu)).filter(match => percentCharacter(shadow, match.index) !== null).map(match => spanAt(match.index));
  let unresolvedIndex = 0;
  for (const segment of value.matchAll(/[^\s/?#]+/gu)) {
    const end = segment.index + segment[0].length;
    while (unresolvedSpans[unresolvedIndex] && (unresolvedSpans[unresolvedIndex]?.start ?? Infinity) < segment.index) unresolvedIndex += 1;
    if (unresolvedSpans[unresolvedIndex] && (unresolvedSpans[unresolvedIndex]?.start ?? Infinity) < end) {
      replacements.push({ start: segment.index, end, replacement: "[redacted]", priority: 0 });
    }
  }
  const patterns = [
    [/(\bBearer\s+)([A-Za-z0-9._~+/=-]+)\b/giu, "[credential]"],
    [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|secret|password|code|state)=)([^\s&]+)/giu, "[redacted]"],
    [/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]"],
  ] as const;
  for (const [priority, [pattern, replacement]] of patterns.entries()) {
    for (const match of shadow.matchAll(pattern)) {
      // Optional groups retain the original encoded prefix (scheme, key,
      // or Bearer separator) and replace only the credential itself.
      const offset = match.index + (match[1]?.length ?? 0);
      const length = (match[2] ?? match[0]).length;
      const start = spanAt(offset).start;
      const end = spanAt(offset + length - 1).end;
      replacements.push({ start, end, replacement, priority: priority + 2 });
    }
  }
  for (const { start, end } of userinfoSpans(shadow)) {
    replacements.push({ start: spanAt(start).start, end: spanAt(end - 1).end, replacement: "[credential]", priority: 1 });
  }
  for (const { start, end } of emailSpans(shadow)) {
    replacements.push({ start: spanAt(start).start, end: spanAt(end - 1).end, replacement: "[email]", priority: 6 });
  }
  replacements.sort((left, right) => left.start - right.start || left.priority - right.priority || right.end - left.end);
  let result = "";
  let cursor = 0;
  for (const { start, end, replacement } of replacements) {
    if (start < cursor) continue;
    result += value.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + value.slice(cursor);
}

function removeRelativePathQueries(value: string): string {
  return value.replace(/[^\s)]+/gu, token => token.split("#").map(part => {
    const slash = part.indexOf("/");
    if (slash < 0) return part;
    const query = part.indexOf("?", slash + 1);
    return query > slash + 1 ? part.slice(0, query) : part;
  }).join("#"));
}

export function redactSensitiveText(value: string): string {
  // Bound every input before inspection, including entirely raw strings.
  // Redact overflow instead of truncating a potentially sensitive identifier.
  if (value.length > MAX_INSPECTION_LENGTH) return "[redacted]";
  return removeRelativePathQueries(redactEncodedIdentifiers(value)
    .replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#)]*)?(?:#[^\s)]*)?/giu, "$1")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|secret|password|code|state)=([^\s&]+)/giu, "$1=[redacted]"));
}

