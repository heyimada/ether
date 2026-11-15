import { count, inArray } from "drizzle-orm";
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
