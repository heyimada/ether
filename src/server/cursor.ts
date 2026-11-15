import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

// Newest-first lists are paged with "<ms>-<id>" of the last row shown: rows created before it, or at the same moment
// with a smaller id.
export const cursorOf = (at: Date, id: number) => `${at.getTime()}-${id}`;

export function olderThan(createdAt: SQLiteColumn, id: SQLiteColumn, cursor: string | undefined): SQL | undefined {
  const m = /^(\d+)-(\d+)$/.exec(cursor ?? "");
  if (!m) return undefined;
  const at = new Date(Number(m[1]));
  return or(lt(createdAt, at), and(eq(createdAt, at), lt(id, Number(m[2]))));
}
