/**
 * Shared types for the memory package.
 *
 * MemoryStore and MemoryEntry are defined here to avoid a circular
 * dependency on @kirie/core. The @kirie/core MemoryStore class
 * already satisfies this interface.
 */

export interface MemoryEntry {
  id: number;
  key: string;
  content: string;
  contentHash?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MemoryStore {
  store(key: string, content: string, tags?: string[]): MemoryEntry;
  recall(key: string): MemoryEntry | null;
  search(query: string, limit?: number): MemoryEntry[];
  list(tag?: string, limit?: number): MemoryEntry[];
  delete(key: string): boolean;
  close(): void;
}
