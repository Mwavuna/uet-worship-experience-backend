import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { songs } from "./db/schema.js";
import SEED from "./songs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "";

const columns = {
  id: songs.id,
  setName: songs.setName,
  title: songs.title,
  artist: songs.artist,
  note: songs.note,
  done: songs.done,
  lyrics: songs.lyrics,
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Validates and cleans a request body. requireAll is true for create.
function parseFields(body = {}, requireAll) {
  const out = {};
  const text = (key, max, required) => {
    const v = body[key];
    if (v === undefined) {
      if (requireAll && required) throw httpError(400, `${key} is required`);
      return;
    }
    if (typeof v !== "string") throw httpError(400, `${key} must be text`);
    const t = v.trim();
    if (required && !t) throw httpError(400, `${key} cannot be empty`);
    if (t.length > max) throw httpError(400, `${key} is too long`);
    out[key] = t;
  };
  text("setName", 100, true);
  text("title", 200, true);
  text("artist", 200, false);
  text("note", 200, false);
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") throw httpError(400, "done must be true or false");
    out.done = body.done;
  }
  if (body.lyrics !== undefined) {
    if (typeof body.lyrics !== "string") throw httpError(400, "lyrics must be text");
    out.lyrics = body.lyrics;
  }
  return out;
}

// Finds the position just after the last song of a set (making room), or the end of the list.
async function slotFor(tx, setName, excludeId) {
  const inSet = excludeId
    ? and(eq(songs.setName, setName), ne(songs.id, excludeId))
    : eq(songs.setName, setName);
  const [last] = await tx.select({ m: sql`max(${songs.position})` }).from(songs).where(inSet);
  if (last.m !== null) {
    await tx
      .update(songs)
      .set({ position: sql`${songs.position} + 1` })
      .where(gt(songs.position, last.m));
    return last.m + 1;
  }
  const [all] = await tx.select({ m: sql`max(${songs.position})` }).from(songs);
  return (all.m ?? -1) + 1;
}

const parseId = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw httpError(400, "Bad song id");
  return id;
};

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-access-code"],
  })
);
app.options("*", cors());
app.use(express.json({ limit: "200kb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// Optional shared access code for the whole API
app.use("/api", (req, res, next) => {
  if (ACCESS_CODE && req.get("x-access-code") !== ACCESS_CODE) {
    console.warn(`[${new Date().toISOString()}] Unauthorized request: ${req.method} ${req.originalUrl} from ${req.ip}`);
    return res.status(401).json({ error: "Access code required" });
  }
  next();
});

// READ all
app.get("/api/songs", wrap(async (req, res) => {
  res.json(await db.select(columns).from(songs).orderBy(asc(songs.position)));
}));

// READ one
app.get("/api/songs/:id", wrap(async (req, res) => {
  const [row] = await db.select(columns).from(songs).where(eq(songs.id, parseId(req)));
  if (!row) throw httpError(404, "Song not found");
  res.json(row);
}));

// CREATE
app.post("/api/songs", wrap(async (req, res) => {
  const fields = parseFields(req.body, true);
  const row = await db.transaction(async (tx) => {
    const position = await slotFor(tx, fields.setName);
    const [created] = await tx.insert(songs).values({ ...fields, position }).returning(columns);
    return created;
  });
  res.status(201).json(row);
}));

// UPDATE (any of: setName, title, artist, note, done, lyrics)
app.patch("/api/songs/:id", wrap(async (req, res) => {
  const id = parseId(req);
  const fields = parseFields(req.body, false);
  if (Object.keys(fields).length === 0) throw httpError(400, "Nothing to update");

  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select({ setName: songs.setName }).from(songs).where(eq(songs.id, id));
    if (!current) throw httpError(404, "Song not found");
    const changes = { ...fields, updatedAt: new Date() };
    if (fields.setName !== undefined && fields.setName !== current.setName) {
      changes.position = await slotFor(tx, fields.setName, id);
    }
    const [updated] = await tx.update(songs).set(changes).where(eq(songs.id, id)).returning(columns);
    return updated;
  });
  res.json(row);
}));

// DELETE
app.delete("/api/songs/:id", wrap(async (req, res) => {
  const [row] = await db.delete(songs).where(eq(songs.id, parseId(req))).returning({ id: songs.id });
  if (!row) throw httpError(404, "Song not found");
  res.json({ ok: true, id: row.id });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Serve the built React app in production (npm run build first)
const dist = path.join(__dirname, "../../client/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const requestLog = {
    method: req.method,
    url: req.originalUrl,
    status,
    message: err.message,
    stack: err.stack,
    ip: req.ip,
  };

  console.error(`[${new Date().toISOString()}] Request failed:`, requestLog);

  if (err.status) return res.status(status).json({ error: err.message });
  res.status(status).json({ error: "Server error" });
});

async function seedIfEmpty() {
  const [{ n }] = await db.select({ n: sql`count(*)::int` }).from(songs);
  if (n > 0) return;
  await db.insert(songs).values(
    SEED.map(([setName, title, artist, note], position) => ({ position, setName, title, artist, note }))
  );
  console.log(`Seeded ${SEED.length} songs`);
}

seedIfEmpty()
  .then(() => app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error("Startup failed:", err.message);
    console.error("If the songs table is missing, run: npm run db:push");
    process.exit(1);
  });
