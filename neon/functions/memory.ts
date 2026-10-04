/**
 * Iris memory API (Neon Function)
 *
 * POST /api/memory/ingest                 brain saves a frame (needs INGEST_TOKEN)
 * POST /api/memory/search                 "where did I leave my phone?"
 * GET  /api/memory/moments                every moment in a session, oldest first (garden layout)
 * GET  /api/memory/moments/:id/image      the JPEG
 * GET  /api/memory/moments/:id/depth      cached depth map PNG, 404 until the web app makes one
 * PUT  /api/memory/moments/:id/depth      web app caches a depth map it computed
 * GET  /api/memory/searches/latest       newest question for a session (the garden polls this)
 * GET  /api/memory/health
 *
 * Reads are scoped to one judge's session. A verified Neon Auth token decides
 * the session when one is sent; otherwise the session_id in the request does.
 * Only ingest needs the shared token, which never ships to the browser.
 *
 * Photos and depth maps live in the private `uploads` bucket (Neon Object
 * Storage). The memories table keeps their keys.
 *
 * DATABASE_URL is injected by Neon. Everything else comes from neon.ts.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { attachDatabasePool } from "@neon/functions";
import { Pool, types } from "pg";
import OpenAI from "openai";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";

// Ids are bigint in Postgres. Return them as plain numbers (safe far beyond
// any hackathon's row count) so every caller sees numeric ids.
types.setTypeParser(20, (v) => Number(v));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

// Created on first use so a missing key shows up as a clear request error,
// not a crash when the function boots.
let openaiClient: OpenAI | undefined;
function openai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  // No automatic retries. A retry would blow the caller's time budget, and a
  // dropped frame or a re-asked question is cheaper than a stalled one.
  return (openaiClient ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // Any OpenAI-compatible API. Empty means OpenAI itself. For OpenRouter,
    // use https://openrouter.ai/api/v1 and model names like openai/gpt-4o-mini.
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    maxRetries: 0,
    timeout: OPENAI_CLIENT_TIMEOUT_MS, // backstop, some calls set an even shorter budget
  }));
}

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small"; // must produce 1536 dimensions to match the table
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4o-mini";
const DEDUPE_THRESHOLD = Number(process.env.DEDUPE_THRESHOLD || "0.95");
const MIN_SIMILARITY = Number(process.env.SEARCH_MIN_SIMILARITY || "0.45");
const MAX_IMAGE_BYTES = 2_000_000;

// Time budgets. Search is one embedding call and one query, so it answers well
// inside the brain's 2 s budget. Ingest gives up within 8 s.
const SEARCH_EMBED_TIMEOUT_MS = 1_500;
const DESCRIBE_TIMEOUT_MS = 3_000; // only used when the brain didn't send a description
const INGEST_EMBED_TIMEOUT_MS = 2_000;
const OPENAI_CLIENT_TIMEOUT_MS = 3_000; // every OpenAI call gives up within about 3 s
const MAX_DEPTH_BYTES = 5_000_000;

const DESCRIBE_PROMPT =
  "You are describing a frame from smart glasses for a memory search system. " +
  "First list every clearly visible object using plain everyday names " +
  "(phone, keys, laptop, water bottle). Then write one sentence on where this " +
  "is and what is happening. No speculation.";

// ---------------------------------------------------------------- object storage

// Declared in neon.ts. Neon injects the AWS_* credentials for it.
const BUCKET = process.env.UPLOADS_BUCKET || "uploads";
const STORAGE_TIMEOUT_MS = 3_000;

let s3Client: S3Client | undefined;
function s3(): S3Client {
  if (!process.env.AWS_ENDPOINT_URL_S3) throw new Error("object storage isn't configured, declare the uploads bucket in neon.ts and deploy");
  return (s3Client ??= new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  }));
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }), {
    abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
}

async function getObject(key: string): Promise<Buffer | null> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
  } catch (err) {
    if ((err as { name?: string })?.name === "NoSuchKey") return null;
    throw err;
  }
}

// ---------------------------------------------------------------- Neon Auth

// Set by Neon when `auth: true` is in neon.ts.
const jwks = process.env.NEON_AUTH_JWKS_URL ? createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL)) : null;
const issuer = process.env.NEON_AUTH_BASE_URL ? new URL(process.env.NEON_AUTH_BASE_URL).origin : undefined;

/**
 * Which judge this request is for. A verified Neon Auth token wins, so a
 * signed-in judge can only ever reach their own memories. Without a token,
 * the session_id the caller passed is used, which keeps the brain and older
 * pages working. A token that's present but invalid is rejected.
 */
async function resolveSession(c: Context, claimed: string | undefined): Promise<{ sessionId?: string; denied?: Response }> {
  const auth = c.req.header("authorization");
  if (jwks && auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token.split(".").length === 3) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer });
        if (payload.sub) return { sessionId: payload.sub };
      } catch {
        return { denied: c.json({ error: "sign-in token is invalid or expired" }, 401) };
      }
    }
  }
  return { sessionId: claimed };
}

// ---------------------------------------------------------------- AI helpers

async function describe(jpeg: Buffer): Promise<string> {
  const url = process.env.DESCRIBE_URL;
  if (url) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: new Uint8Array(jpeg),
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`describe endpoint returned ${r.status}`);
    const { description } = (await r.json()) as { description?: string };
    if (!description) throw new Error("describe endpoint returned no description");
    return description.trim();
  }

  const resp = await openai().chat.completions.create(
    {
      model: VISION_MODEL,
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DESCRIBE_PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          ],
        },
      ],
    },
    { timeout: DESCRIBE_TIMEOUT_MS },
  );
  const text = resp.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("vision model returned an empty description");
  return text;
}

const STOPWORDS = new Set(
  "where what when which did do does is are was were i me my mine the a an our we you it its last see saw seen put leave left lose lost find found have had has can could would should please i'd i've where's what's".split(" "),
);

/** Pulls the object out of the question with no model call, so search stays fast. */
// Words that trail the object in a question ("my keys last night") but aren't part of it.
const TRAILING = /\s+(?:earlier|today|tonight|yesterday|last|just|again|before|recently|this|that|ago|now|please)\b.*$/;

export function guessTarget(question: string): string {
  const q = question.toLowerCase().replace(/[?!.,']/g, (m) => (m === "'" ? "'" : " ")).replace(/\s+/g, " ").trim();
  // "...my phone", "...the water bottle is", "...our keys at"
  const after = q.match(/\b(?:my|the|our|a|an)\s+([a-z0-9][a-z0-9 ]{0,40}?)(?:\s+(?:is|are|was|were|at|in|on|go|went)\b|$)/);
  if (after) return after[1].replace(TRAILING, "").trim() || after[1].trim();
  const words = q.split(" ").filter((w) => w && !STOPWORDS.has(w));
  return words.slice(-2).join(" ") || q;
}

async function embed(text: string, timeoutMs: number): Promise<number[]> {
  const resp = await openai().embeddings.create(
    { model: EMBED_MODEL, input: text, encoding_format: "float" },
    { timeout: timeoutMs },
  );
  return resp.data[0].embedding;
}

// ---------------------------------------------------------------- helpers

function momentUrls(base: string, id: number, sessionId: string) {
  const q = `?session_id=${encodeURIComponent(sessionId)}`;
  return {
    image_url: `${base}/api/memory/moments/${id}/image${q}`,
    depth_url: `${base}/api/memory/moments/${id}/depth${q}`,
  };
}

function requestOrigin(url: string): string {
  return new URL(url).origin;
}

type Candidate = {
  id: number;
  captured_at: Date;
  description: string;
  similarity: number;
  keyword_match: boolean;
  has_depth: boolean;
};

/**
 * Which candidate answers the question. "Where is it" means "where did I last
 * see it", so the newest real match wins. A moment that names the object is a
 * real match. Only when none does is a moment that just resembles it accepted,
 * and then it has to clear the similarity floor: unrelated moments in one room
 * score around 0.2 to 0.3 against each other.
 */
export function pickMoment<T extends Pick<Candidate, "captured_at" | "similarity" | "keyword_match">>(
  rows: T[],
  minSimilarity = MIN_SIMILARITY,
): T | undefined {
  const named = rows.filter((r) => r.keyword_match);
  const matches = named.length ? named : rows.filter((r) => r.similarity > minSimilarity);
  return [...matches].sort((a, b) => +b.captured_at - +a.captured_at)[0];
}

// ---------------------------------------------------------------- routes

/** A database or network hiccup returns a clear 503 instead of crashing the request. */
function unavailable(c: Context, where: string, err: unknown) {
  console.error(`[${where}]`, err);
  return c.json({ error: `memory is temporarily unavailable (${where})` }, 503);
}

const app = new Hono().basePath("/api/memory");

// Last line of defense for anything a route didn't catch itself.
app.onError((err, c) => unavailable(c, "unhandled", err));

app.use("*", cors({ origin: process.env.WEB_ORIGIN || "*", allowMethods: ["GET", "POST", "PUT", "OPTIONS"] }));

app.get("/health", (c) => c.json({ ok: true }));

app.post("/ingest", async (c) => {
  const token = process.env.INGEST_TOKEN;
  if (!token) return c.json({ error: "INGEST_TOKEN not configured" }, 500);
  if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);

  const sessionId = c.req.header("x-session-id");
  if (!sessionId) return c.json({ error: "missing X-Session-Id" }, 400);

  const jpeg = Buffer.from(await c.req.arrayBuffer());
  if (jpeg.length === 0) return c.json({ error: "empty body" }, 400);
  if (jpeg.length > MAX_IMAGE_BYTES) return c.json({ error: "image too large" }, 413);

  const started = Date.now();
  try {
    const capturedRaw = c.req.header("x-captured-at");
    const capturedAt = capturedRaw ? new Date(capturedRaw) : null;
    if (capturedAt && Number.isNaN(capturedAt.getTime())) return c.json({ error: "X-Captured-At must be an ISO 8601 time" }, 400);

    const given = c.req.header("x-description");
    const description = given ? decodeURIComponent(given) : await describe(jpeg);
    const embedding = await embed(description, INGEST_EMBED_TIMEOUT_MS);

    // Dedupe and insert happen atomically inside Postgres. The photo is uploaded
    // inside the same transaction, so a moment only becomes visible once its
    // photo is stored, and a failed upload leaves no broken moment behind.
    const imageKey = `moments/${randomUUID()}.jpg`;
    let id: number | null = null;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows } = await db.query<{ id: number | null }>(
        "SELECT insert_memory_if_new($1, $2, $3, $4::vector, $5, $6) AS id",
        [sessionId, imageKey, description, JSON.stringify(embedding), DEDUPE_THRESHOLD, capturedAt],
      );
      id = rows[0]?.id ?? null;
      if (id !== null) await putObject(imageKey, jpeg, "image/jpeg");
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
    return c.json({ saved: id !== null, id, description, ms: Date.now() - started });
  } catch (err) {
    console.error("[ingest]", err);
    return c.json({ error: String(err) }, 502);
  }
});

app.post("/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { sessionId, denied } = await resolveSession(c, typeof body?.session_id === "string" ? body.session_id : undefined);
  if (denied) return denied;
  const question: unknown = body?.question;
  if (!sessionId) return c.json({ error: "missing session_id" }, 400);
  if (typeof question !== "string" || !question.trim()) return c.json({ error: "missing question" }, 400);

  const started = Date.now();
  try {
    // One embedding call and one query, so search fits the brain's 2 s budget.
    // The object comes from the question's words (or the caller's target), not a model.
    const target = typeof body.target === "string" && body.target.trim() ? body.target.trim() : guessTarget(question);
    const embedding = await embed(`a photo with ${target} in it`, SEARCH_EMBED_TIMEOUT_MS);

    const { rows } = await pool.query<Candidate>(
      "SELECT * FROM memory_candidates($1, $2::vector, $3, 20)",
      [sessionId, JSON.stringify(embedding), target],
    );

    const best = pickMoment(rows);
    const base = requestOrigin(c.req.url);
    const shape = (r: Candidate) => ({ ...r, ...momentUrls(base, r.id, sessionId) });

    // Log it so the VR garden can follow questions asked anywhere. Never fails the search.
    let searchId: number | null = null;
    try {
      const logged = await pool.query<{ id: number }>(
        "INSERT INTO memory_searches (session_id, question, target, moment_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [sessionId, question, target, best?.id ?? null],
      );
      searchId = logged.rows[0]?.id ?? null;
    } catch (err) {
      console.error("[search] could not log search", err);
    }

    return c.json({
      search_id: searchId,
      target,
      moment: best ? shape(best) : null,
      top: [...rows].sort((a, b) => b.similarity - a.similarity).slice(0, 5).map(shape),
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error("[search]", err);
    return c.json({ error: String(err) }, 502);
  }
});

app.get("/searches/latest", async (c) => {
  try {
    const { sessionId, denied } = await resolveSession(c, c.req.query("session_id"));
    if (denied) return denied;
    if (!sessionId) return c.json({ error: "missing session_id" }, 400);
    const { rows } = await pool.query<{ id: number; asked_at: Date; question: string; target: string; moment_id: number | null }>(
      `SELECT id, asked_at, question, target, moment_id
       FROM memory_searches WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    return c.json({ search: rows[0] ?? null });
  } catch (err) {
    return unavailable(c, "searches", err);
  }
});

app.get("/moments", async (c) => {
  try {
    const { sessionId, denied } = await resolveSession(c, c.req.query("session_id"));
    if (denied) return denied;
    if (!sessionId) return c.json({ error: "missing session_id" }, 400);
    const limit = Math.min(Number(c.req.query("limit") || 500), 2000);

    const { rows } = await pool.query<{ id: number; captured_at: Date; description: string; has_depth: boolean }>(
      `SELECT id, captured_at, description, depth_key IS NOT NULL AS has_depth
       FROM memories WHERE session_id = $1 ORDER BY captured_at ASC LIMIT $2`,
      [sessionId, limit],
    );
    const base = requestOrigin(c.req.url);
    return c.json({ moments: rows.map((r) => ({ ...r, ...momentUrls(base, r.id, sessionId) })) });
  } catch (err) {
    return unavailable(c, "moments", err);
  }
});

app.get("/moments/:id/image", async (c) => {
  try {
    const { sessionId, denied } = await resolveSession(c, c.req.query("session_id"));
    if (denied) return denied;
    if (!sessionId) return c.json({ error: "missing session_id" }, 400);
    const { rows } = await pool.query<{ image_key: string | null }>(
      "SELECT image_key FROM memories WHERE id = $1 AND session_id = $2",
      [c.req.param("id"), sessionId],
    );
    const key = rows[0]?.image_key;
    const image = key ? await getObject(key) : null;
    if (!image) return c.json({ error: "not found" }, 404);
    return c.body(new Uint8Array(image), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=86400, immutable",
    });
  } catch (err) {
    return unavailable(c, "image", err);
  }
});

app.get("/moments/:id/depth", async (c) => {
  try {
    const { sessionId, denied } = await resolveSession(c, c.req.query("session_id"));
    if (denied) return denied;
    if (!sessionId) return c.json({ error: "missing session_id" }, 400);
    const { rows } = await pool.query<{ depth_key: string | null }>(
      "SELECT depth_key FROM memories WHERE id = $1 AND session_id = $2",
      [c.req.param("id"), sessionId],
    );
    const key = rows[0]?.depth_key;
    const depth = key ? await getObject(key) : null;
    if (!depth) return c.json({ error: "no depth yet" }, 404);
    return c.body(new Uint8Array(depth), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
    });
  } catch (err) {
    return unavailable(c, "depth", err);
  }
});

app.put("/moments/:id/depth", async (c) => {
  try {
    const { sessionId, denied } = await resolveSession(c, c.req.query("session_id"));
    if (denied) return denied;
    if (!sessionId) return c.json({ error: "missing session_id" }, 400);
    const png = Buffer.from(await c.req.arrayBuffer());
    const isPng = png.length > 8 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) return c.json({ error: "body must be a PNG" }, 400);
    if (png.length > MAX_DEPTH_BYTES) return c.json({ error: "depth map too large" }, 413);

    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM memories WHERE id = $1 AND session_id = $2",
      [c.req.param("id"), sessionId],
    );
    if (!rows[0]) return c.json({ error: "not found" }, 404);
    const key = `depth/${rows[0].id}.png`;
    await putObject(key, png, "image/png");
    await pool.query("UPDATE memories SET depth_key = $2 WHERE id = $1", [rows[0].id, key]);
    return c.json({ ok: true });
  } catch (err) {
    return unavailable(c, "depth", err);
  }
});

export default app;
