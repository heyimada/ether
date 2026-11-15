import { count, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/client";
import { star } from "./db/schema";

export function starCounts(repoIds: number[]): Map<number, number> {
  if (repoIds.length === 0) return new Map();
  return new Map(
    db
      .select({ repoId: star.repoId, n: count() })
      .from(star)
      .where(inArray(star.repoId, repoIds))
      .groupBy(star.repoId)
      .all()
      .map((r) => [r.repoId, r.n]),
  );
}

// The repositories someone starred, most recent first.
export const starredBy = (userId: string) =>
  db.select({ repoId: star.repoId }).from(star).where(eq(star.userId, userId)).orderBy(desc(star.createdAt)).all().map((s) => s.repoId);
