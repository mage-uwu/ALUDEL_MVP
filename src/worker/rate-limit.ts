/// <reference types="@cloudflare/workers-types" />

export interface RatePolicy {
  limit: number;
  windowSeconds: number;
}

export interface RateResult {
  allowed: boolean;
  retryAfter: number;
}

const subjectHash = async (subject: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** One atomic fixed-window counter. Subjects are hashed so client IPs never land in D1. */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  subject: string,
  policy: RatePolicy
): Promise<RateResult> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / policy.windowSeconds);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, subject, window, hits) VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, subject) DO UPDATE SET
         hits = CASE WHEN rate_limits.window = excluded.window THEN rate_limits.hits + 1 ELSE 1 END,
         window = excluded.window
       RETURNING hits`
    )
    .bind(bucket, await subjectHash(subject), window)
    .first<{ hits: number }>();
  const retryAfter = policy.windowSeconds - (now % policy.windowSeconds);
  return { allowed: (row?.hits ?? policy.limit + 1) <= policy.limit, retryAfter };
}
