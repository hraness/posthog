/** Helpers shared by the server, Meta and CLI entries. Not exported from the package. */

export type Bag = Record<string, unknown>;
export const bag = (value: unknown): Bag | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : undefined;
export const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const encoder = new TextEncoder();
const hexOf = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

/** The RFC 4122 URL namespace. */
const NAMESPACE = Uint8Array.from([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
/** A UUIDv5 naming one logical event, so a redelivery is the same PostHog event. */
export async function uuidV5(name: string): Promise<string> {
  const text = encoder.encode(name);
  const input = new Uint8Array(NAMESPACE.length + text.length);
  input.set(NAMESPACE);
  input.set(text, NAMESPACE.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = hexOf(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
/** Stripe's minor units per currency, with its two-decimal treatment of ISK and UGX. */
export function decimalsOf(currency: string): number {
  return ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;
}

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** A job run after the response with a deadline; failures are swallowed. */
export function later(waitUntil: ((job: Promise<unknown>) => void) | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const job = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      await work(controller.signal);
    } catch {
      // Measurement never fails the request it rides on.
    } finally {
      clearTimeout(timer);
    }
  })();
  try {
    waitUntil?.(job);
  } catch {
    // No context: the job still runs.
  }
  return job;
}
