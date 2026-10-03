-- Iris memory store (Neon Postgres + pgvector)
-- Owner: Darren
--
-- Safe to run more than once. Paste the whole file into the Neon SQL Editor.

CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------------
-- Table
-- One row per saved moment. The photo and depth map live in the private
-- `uploads` bucket (Neon Object Storage), and the row keeps their keys.
-- search_tsv lets a literal "phone" in a description count as a match.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   text         NOT NULL,
  captured_at  timestamptz  NOT NULL DEFAULT now(),
  image_key    text         NOT NULL,   -- uploads/<key>, the JPEG
  description  text         NOT NULL,
  embedding    vector(1536) NOT NULL,   -- OpenAI text-embedding-3-small

  depth_key    text,                    -- uploads/<key>, PNG, filled the first time a moment opens in 3D
  search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', description)) STORED
);

-- Upgrade a table made by an earlier version of this file, which stored the
-- images in the row. Does nothing on a fresh database.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS image_key text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS depth_key text;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'image') THEN
    ALTER TABLE memories ALTER COLUMN image DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS memories_session_time ON memories (session_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS memories_tsv ON memories USING gin (search_tsv);

-- At hackathon scale an exact scan inside one session takes milliseconds and
-- avoids the recall problems an ANN index has under a WHERE filter.
-- CREATE INDEX memories_embedding_hnsw ON memories USING hnsw (embedding vector_cosine_ops);


-- ------------------------------------------------------------------
-- insert_memory_if_new
-- Dedupe and insert in one atomic step. Returns the new id, or NULL when
-- the frame is more similar than p_threshold to the last saved frame for
-- the session. The advisory lock stops two writers racing on one session.
-- p_captured_at is when the glasses took the photo (NULL means now).
-- ------------------------------------------------------------------
-- Earlier versions took the image bytes. Drop them so only one version exists.
DROP FUNCTION IF EXISTS insert_memory_if_new(text, bytea, text, vector, float8);
DROP FUNCTION IF EXISTS insert_memory_if_new(text, bytea, text, vector, float8, timestamptz);

CREATE OR REPLACE FUNCTION insert_memory_if_new(
  p_session_id  text,
  p_image_key   text,
  p_description text,
  p_embedding   vector(1536),
  p_threshold   float8      DEFAULT 0.95,
  p_captured_at timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_last vector(1536);
  v_id   bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_session_id));

  SELECT m.embedding INTO v_last
  FROM memories m
  WHERE m.session_id = p_session_id
  ORDER BY m.captured_at DESC
  LIMIT 1;

  IF v_last IS NOT NULL AND 1 - (v_last <=> p_embedding) > p_threshold THEN
    RETURN NULL;
  END IF;

  INSERT INTO memories (session_id, captured_at, image_key, description, embedding)
  VALUES (p_session_id, COALESCE(p_captured_at, now()), p_image_key, p_description, p_embedding)
  RETURNING memories.id INTO v_id;

  RETURN v_id;
END;
$$;


-- ------------------------------------------------------------------
-- memory_candidates
-- Everything that could answer "where did I leave X". It unions the
-- nearest frames by meaning with the most recent frames that name the
-- keyword, so a literal mention is never lost just because it ranked
-- outside the semantic top results. The API then keeps the real matches
-- and returns the most recent one.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION memory_candidates(
  p_session_id text,
  p_embedding  vector(1536),
  p_keyword    text,
  p_limit      int DEFAULT 20
)
RETURNS TABLE (
  id            bigint,
  captured_at   timestamptz,
  description   text,
  similarity    float8,
  keyword_match boolean,
  has_depth     boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH semantic AS (
    SELECT m.id
    FROM memories m
    WHERE m.session_id = p_session_id
    ORDER BY m.embedding <=> p_embedding
    LIMIT p_limit
  ),
  keyword AS (
    SELECT m.id
    FROM memories m
    WHERE m.session_id = p_session_id
      AND coalesce(p_keyword, '') <> ''
      AND m.search_tsv @@ plainto_tsquery('english', p_keyword)
    ORDER BY m.captured_at DESC
    LIMIT p_limit
  )
  SELECT m.id,
         m.captured_at,
         m.description,
         1 - (m.embedding <=> p_embedding),
         coalesce(p_keyword, '') <> '' AND m.search_tsv @@ plainto_tsquery('english', p_keyword),
         m.depth_key IS NOT NULL
  FROM memories m
  WHERE m.id IN (SELECT s.id FROM semantic s UNION SELECT k.id FROM keyword k)
$$;


-- ------------------------------------------------------------------
-- memory_searches
-- Every question asked, from any caller. The VR garden polls the newest
-- one for its session, so a question asked out loud through the phone
-- page makes the garden fly to the answer. It doubles as a history for
-- the debug dashboard.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_searches (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  text        NOT NULL,
  asked_at    timestamptz NOT NULL DEFAULT now(),
  question    text        NOT NULL,
  target      text        NOT NULL,
  moment_id   bigint      REFERENCES memories (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS memory_searches_session ON memory_searches (session_id, id DESC);

