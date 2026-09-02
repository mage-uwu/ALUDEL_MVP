/// <reference types="@cloudflare/workers-types" />
// The assistant: chats with xAI Grok, kept per user in that user's own Durable
// Object (SQLite-backed). The key never leaves the Worker; a reply streams to
// the client as it is written and is saved with the question once complete.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const MODEL = "grok-4.6";
const XAI = "https://api.x.ai/v1";
const SYSTEM = "You are Aludel, a powerful and professional AI assistant.";
/** Turns sent to the model per reply, the size of one turn, and a title's length. */
export const CHAT = { window: 20, chars: 4000, title: 60 } as const;

export type Turn = {
  role: "user" | "assistant";
  content: string;
};
export type ChatMeta = {
  id: string;
  title: string;
  updatedAt: string;
};

/**
 * One user's chats. Keyed by user id, so isolation is by construction: no
 * query in here can reach another user's rows, because they live elsewhere.
 */
export class ChatStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq)
      );
    `);
  }

  list(): ChatMeta[] {
    return this.sql
      .exec<ChatMeta>("SELECT id, title, updated_at AS updatedAt FROM chats ORDER BY updated_at DESC LIMIT 200")
      .toArray();
  }

  /** The chat and every turn in it, oldest first; null if there is no such chat. */
  get(id: string): { meta: ChatMeta; turns: Turn[] } | null {
    const meta = this.sql.exec<ChatMeta>("SELECT id, title, updated_at AS updatedAt FROM chats WHERE id = ?", id).toArray()[0];
    if (!meta) return null;
    const turns = this.sql.exec<Turn>("SELECT role, content FROM messages WHERE chat_id = ? ORDER BY seq", id).toArray();
    return { meta, turns };
  }

  has(id: string): boolean {
    return this.sql.exec("SELECT 1 FROM chats WHERE id = ?", id).toArray().length > 0;
  }

  /** The last few turns, for the model's window. */
  recent(id: string, n: number): Turn[] {
    return this.sql
      .exec<Turn>("SELECT role, content FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?", id, n)
      .toArray()
      .reverse();
  }

  /** Start a chat titled after its first line. */
  create(firstLine: string): ChatMeta {
    const now = new Date().toISOString();
    const meta = { id: crypto.randomUUID(), title: firstLine.slice(0, CHAT.title), updatedAt: now };
    this.sql.exec("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", meta.id, meta.title, now, now);
    return meta;
  }

  /** Append turns to a chat, in order. */
  append(id: string, turns: Turn[]): void {
    const next = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM messages WHERE chat_id = ?", id).one().n;
    turns.forEach((t, i) => this.sql.exec("INSERT INTO messages (chat_id, seq, role, content) VALUES (?, ?, ?, ?)", id, next + i, t.role, t.content));
    this.sql.exec("UPDATE chats SET updated_at = ? WHERE id = ?", new Date().toISOString(), id);
  }

  remove(id: string): boolean {
    this.sql.exec("DELETE FROM messages WHERE chat_id = ?", id);
    return this.sql.exec("DELETE FROM chats WHERE id = ?", id).rowsWritten > 0;
  }
}

/** The signed-in user's store. */
export const storeFor = (env: Env, userId: string) => env.CHATS.get(env.CHATS.idFromName(userId));

/**
 * One reply as a stream of plain-text chunks. History comes from the store,
 * and when the stream ends the question and the whole answer are saved.
 */
export async function ask(env: Env, store: DurableObjectStub<ChatStore>, chatId: string, content: string): Promise<ReadableStream<Uint8Array>> {
  const history = await store.recent(chatId, CHAT.window - 1);
  const res = await fetch(`${env.XAI_ENDPOINT ?? XAI}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.XAI_API_KEY}`,
      // sticky per chat so cached input pricing applies to the shared prefix
      "x-grok-conv-id": `aludel-${chatId}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...history, { role: "user", content }],
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
  let reply = "";
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
            if (text) {
              reply += text;
              out.enqueue(encoder.encode(text));
            }
          } catch {
            /* a partial or foreign line: skip it */
          }
        }
      },
      async flush() {
        if (reply.trim()) await store.append(chatId, [{ role: "user", content }, { role: "assistant", content: reply }]);
      },
    })
  );
}
