import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, dataPath } from "../config";
import * as schema from "./schema";

mkdirSync(config.dataDir, { recursive: true });

const sqlite = new Database(dataPath("db"), { create: true });
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

export const db = drizzle({ client: sqlite, schema });

migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../../../drizzle") });

export { schema };
