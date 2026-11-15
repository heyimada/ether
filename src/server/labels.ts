import { db } from "./db/client";
import { label } from "./db/schema";

export const DEFAULT_LABELS = [
  { name: "bug", color: "#d73a4a", description: "Something isn't working" },
  { name: "enhancement", color: "#a2eeef", description: "New feature or request" },
  { name: "documentation", color: "#0075ca", description: "Improvements or additions to documentation" },
  { name: "question", color: "#d876e3", description: "Further information is requested" },
];

export const addDefaultLabels = (repoId: number) => db.insert(label).values(DEFAULT_LABELS.map((l) => ({ ...l, repoId }))).onConflictDoNothing().run();
