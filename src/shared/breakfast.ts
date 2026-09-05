export type ImportState = "uploading" | "uncertain" | "processing" | "importing" | "complete" | "failed";
export interface ImportJob {
  id: string;
  name: string;
  state: ImportState;
  phase: string;
  percent: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  filed: number;
  duplicates: number;
  rejected: number;
  total: number;
  processed: number;
  resumable: boolean;
  errors?: { record: string; error: string }[];
}
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const IMPORT_EXTENSIONS = /\.(zip|csv|tsv|json|jsonl|ndjson|txt|text|md|markdown)$/i;
