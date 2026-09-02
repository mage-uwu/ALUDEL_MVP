/// <reference types="@cloudflare/workers-types" />
// The assistant: one chat turn with xAI Grok. The key never leaves the Worker;
// the client sends the conversation so far and gets plain text back, streamed
// as it is written.
import type { Env } from "./index";

const MODEL = "grok-4.6";
const XAI = "https://api.x.ai/v1";
const SYSTEM = "You are Aludel, a powerful and professional AI assistant.";
export const CHAT = { turns: 20, chars: 4000 } as const;

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** Clamp an untrusted conversation; null unless it is one that ends with the user speaking. */
export function readTurns(v: unknown): Turn[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > CHAT.turns) return null;
  const turns: Turn[] = [];
  for (const t of v as Partial<Turn>[]) {
    if ((t?.role !== "user" && t?.role !== "assistant") || typeof t.content !== "string" || !t.content.trim()) return null;
    turns.push({ role: t.role, content: t.content.trim().slice(0, CHAT.chars) });
  }
  return turns[turns.length - 1]!.role === "user" ? turns : null;
}

/** One completion as a stream of plain-text chunks, or an error with a readable message. */
export async function ask(env: Env, convId: string, turns: Turn[]): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${env.XAI_ENDPOINT ?? XAI}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.XAI_API_KEY}`,
      // sticky per conversation so cached input pricing applies
      "x-grok-conv-id": convId,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...turns],
      reasoning_effort: "low",
      stream: true,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
    const msg = typeof detail?.error === "string" ? detail.error : detail?.error?.message;
    throw new Error(msg ?? `The assistant is unavailable (${res.status})`);
  }
  // server-sent events in, bare text out: each delta's content, nothing else
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return res.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const text = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
            if (text) out.enqueue(encoder.encode(text));
          } catch {
            /* a partial or foreign line: skip it */
          }
        }
      },
    })
  );
}
