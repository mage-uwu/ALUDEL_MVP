/** Historical content is independent of the generated template and its labels. */
export interface SourceDocument {
  schemaVersion: 1;
  mediaType: "text/csv" | "text/tab-separated-values" | "application/json" | "text/plain" | "text/markdown";
  content: string;
  sha256: string;
  delimiter?: string;
}

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export interface ImportHistory {
  schemaVersion: 1;
  /** Present only when captured before extraction. Never synthesize an original. */
  sourceDocument?: SourceDocument;
  /** Older producers and API clients may provide values without a source file. */
  receivedValues?: Record<string, JsonValue>;
}

export const HISTORY_MAX_BYTES = 960 * 1024;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");

/** Check integrity without trimming, coercing, renaming, or dropping any values. */
export async function readImportHistory(value: unknown): Promise<ImportHistory> {
  if (!object(value) || value.schemaVersion !== 1 || (!value.sourceDocument && !object(value.receivedValues))) throw new Error("Missing historical content");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > HISTORY_MAX_BYTES) throw new Error("Historical record exceeds 960 KiB; no content was discarded");
  if (value.sourceDocument !== undefined) {
    const s = value.sourceDocument;
    if (!object(s) || s.schemaVersion !== 1 || typeof s.content !== "string" || typeof s.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(s.sha256) || !["text/csv", "text/tab-separated-values", "application/json", "text/plain", "text/markdown"].includes(String(s.mediaType))
      || (s.delimiter !== undefined && ![",", ";", "\t", "|"].includes(String(s.delimiter)))) throw new Error("Invalid source document contract");
    if (await sha256(s.content) !== s.sha256) throw new Error("Source document checksum mismatch; no record was filed");
  }
  if (value.receivedValues !== undefined && !object(value.receivedValues)) throw new Error("Invalid received historical values");
  return value as unknown as ImportHistory;
}

/** Parse only for display. The saved CSV text remains the authority and download. */
export function sourceCsvRows(content: string, delimiter: string): string[][] | null {
  const rows: string[][] = [], row: string[] = [];
  let cell = "", quoted = false, closed = false;
  for (let i = content.charCodeAt(0) === 0xfeff ? 1 : 0; i < content.length; i++) {
    const c = content[i]!;
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ""; closed = false; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && content[i + 1] === "\n") i++;
      row.push(cell); rows.push(row.splice(0)); cell = ""; closed = false;
    } else if (closed) return null;
    else cell += c;
  }
  if (quoted) return null;
  if (cell !== "" || row.length || closed) { row.push(cell); rows.push(row); }
  return rows;
}
