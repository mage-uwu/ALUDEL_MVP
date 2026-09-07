import { IMPORT_MAX_BYTES } from "../shared/breakfast";
import type { Env } from "./index";

const ORIGIN = "https://breakfast-tm-container.lafayettejcompton.workers.dev";
export class BreakfastError extends Error {
  constructor(message: string, readonly status = 502, readonly retryAfter: string | null = null) { super(message); }
}

/** Both runtime names resolve identically for status, intake, and upstream calls. */
export function breakfastKey(env: Pick<Env, "BREAKFAST_KEY" | "BFAST_API_KEY">): string {
  return env.BREAKFAST_KEY?.trim() || env.BFAST_API_KEY?.trim() || "";
}

/** Bounded streaming also covers clients that omit Content-Length. */
export function limitStream(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > max) throw new BreakfastError("Upload exceeds 64 MiB", 413);
      controller.enqueue(chunk);
    },
  }));
}

export async function breakfast(env: Env, path: string, init: RequestInit = {}, timeout = 20_000): Promise<Record<string, unknown>> {
  const key = breakfastKey(env);
  if (!key) throw new BreakfastError("Document import is not configured", 503);
  const base = env.BFAST_ENDPOINT || ORIGIN;
  // This optional test hook cannot redirect the production key to arbitrary hosts.
  if (base !== ORIGIN && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new BreakfastError("Invalid import configuration", 503);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("accept", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 429 ? "Document processing is busy. Try a new upload after the indicated delay."
      : response.status === 401 || response.status === 403 ? "Document import credentials were rejected. Ask an administrator to check the connection."
        : response.status === 413 ? "Upload exceeds 64 MiB"
          : `Document service returned HTTP ${response.status}`;
    throw new BreakfastError(message, response.status, response.headers.get("retry-after"));
  }
  // Import pages are bounded to 1 MiB by the producer. The graph limit remains
  // for explicit legacy callers; the import queue never buffers a whole graph.
  const max = path.endsWith("/graph") ? 16 * 1024 * 1024 : 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new BreakfastError("Document service returned an empty response");
  const decoder = new TextDecoder(); let raw = "", bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { throw new BreakfastError(path.endsWith("/graph") ? "The processed result is too large. Split the source into smaller uploads." : "Document service returned an oversized response page", 422); }
      raw += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => { }); reader.releaseLock(); }
  raw += decoder.decode();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new BreakfastError("Document service returned invalid JSON"); }
}

export function uploadHeaders(req: Request): Headers {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;.*boundary=/i.test(type)) throw new BreakfastError("Send documents as multipart form data", 415);
  if (!req.body) throw new BreakfastError("Select at least one document", 422);
  if (Number(req.headers.get("content-length") ?? 0) > IMPORT_MAX_BYTES) throw new BreakfastError("Upload exceeds 64 MiB", 413);
  return new Headers({ "content-type": type });
}
