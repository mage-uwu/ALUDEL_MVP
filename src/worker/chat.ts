/// <reference types="@cloudflare/workers-types" />
// The assistant: one chat turn with xAI Grok. The key never leaves the Worker;
// the client sends the conversation so far and gets plain text back.
import type { Env } from "./index";

const MODEL = "grok-4.6";
const XAI = "https://api.x.ai/v1";
const SYSTEM =
  "You are Aludel's assistant for field-service crews: pools, hot tubs, plumbing and the like. " +
  "Answer in plain text only, no markdown, no bullet symbols. Be short and concrete, like a good dispatcher. " +
  "If you don't know something, say so; never invent addresses, prices or names.";
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

/** One completion; plain text back, or an error with a readable message. */
export async function ask(env: Env, convId: string, turns: Turn[]): Promise<string> {
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
      stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
    const msg = typeof detail?.error === "string" ? detail.error : detail?.error?.message;
    throw new Error(msg ?? `The assistant is unavailable (${res.status})`);
  }
  const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("The assistant returned nothing");
  return reply;
}
