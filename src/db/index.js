import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const CONNECTION_STRING = process.env.DATABASE_URL;

if (!CONNECTION_STRING) {
  throw new Error("DATABASE_URL is not set");
} 

const pool = new pg.Pool({
  connectionString:CONNECTION_STRING,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle({ client: pool, schema });
