import { defineConfig } from "@neon/config/v1";

// Deploy from this folder with `npm run deploy`. It loads ../.env so the env
// values below resolve. Only the memory function is declared here, so nothing
// else (like a template's hello function) gets deployed.
//
// Services sit at the top level. The `preview:` block some templates use is
// deprecated since @neon/config 1.6.0, and this project pins 1.8+.
export default defineConfig({
  // Managed Better Auth. Lets each judge sign in, and the memory function
  // trusts a verified Neon Auth token over a session_id in the request.
  auth: true,

  // Moment photos and depth maps. Private, so they're only reachable through
  // the memory function, which checks the session before serving them.
  buckets: {
    uploads: { access: "private" },
  },

  functions: {
    memory: {
      name: "Iris memory API",
      source: "./functions/memory.ts",
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "",
        EMBED_MODEL: process.env.EMBED_MODEL ?? "text-embedding-3-small",
        INGEST_TOKEN: process.env.INGEST_TOKEN ?? "",
        VISION_MODEL: process.env.VISION_MODEL ?? "gpt-4o-mini",
        DESCRIBE_URL: process.env.DESCRIBE_URL ?? "",
        DEDUPE_THRESHOLD: process.env.DEDUPE_THRESHOLD ?? "0.95",
        SEARCH_MIN_SIMILARITY: process.env.SEARCH_MIN_SIMILARITY ?? "0.45",
        WEB_ORIGIN: process.env.WEB_ORIGIN ?? "*",
        UPLOADS_BUCKET: "uploads",
      },
    },
  },
});
