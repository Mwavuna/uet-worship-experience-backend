import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const songs = pgTable("songs", {
  id: serial("id").primaryKey(),
  position: integer("position").notNull(),
  setName: text("set_name").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull().default(""),
  note: text("note").notNull().default(""),
  done: boolean("done").notNull().default(false),
  lyrics: text("lyrics").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
