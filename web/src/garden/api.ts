// Talks to the Iris memory API on Neon. Reads need only the session id, so
// nothing secret ships to the browser. A signed-in judge's requests for their
// own session also carry their Neon Auth token, and memory then answers for
// that judge whatever session id the request names.

import { forgetToken, tokenFor } from "../judge";

export type Moment = {
  id: number;
  captured_at: string;
  description: string;
  has_depth: boolean;
  image_url: string;
  depth_url: string;
  similarity?: number;
  keyword_match?: boolean;
};

export type SearchResult = {
  search_id: number | null;
  target: string;
  moment: Moment | null;
  top: Moment[];
  ms: number;
};

export type LoggedSearch = {
  id: number;
  asked_at: string;
  question: string;
  target: string;
  moment_id: number | null;
};

const ROOT = (import.meta.env.VITE_MEMORY_URL ?? "").replace(/\/$/, "");
const BASE = `${ROOT}/api/memory`;

export const memoryConfigured = ROOT.length > 0;

// Every request to memory gives up after 4 s, so a slow call never hangs the garden.
const FETCH_TIMEOUT_MS = 4_000;

/** A request to memory for one session. If memory refuses the judge's token (expired, or sign-in changed), the
 *  request is made again the no-login way, so a sign-in problem never empties the garden. */
async function ask(sessionId: string, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await tokenFor(sessionId);
  const send = (auth: string | null) =>
    fetch(url, { ...init, headers: { ...init.headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const res = await send(token);
  if (res.status !== 401 || !token) return res;
  forgetToken();
  return send(null);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`memory API returned ${res.status}`);
  return res.json() as Promise<T>;
}

// Memory lists a session oldest first and stops at 500 unless asked for more. A long session has more than
// that, and the newest moments, the ones a search usually finds, are the ones left out. Ask for all it will give.
const MOMENTS_LIMIT = 2000;

export async function listMoments(sessionId: string): Promise<Moment[]> {
  const res = await ask(sessionId, `${BASE}/moments?session_id=${encodeURIComponent(sessionId)}&limit=${MOMENTS_LIMIT}`);
  return (await json<{ moments: Moment[] }>(res)).moments;
}

export async function search(sessionId: string, question: string): Promise<SearchResult> {
  const res = await ask(sessionId, `${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, question }),
  });
  return json<SearchResult>(res);
}

export async function latestSearch(sessionId: string): Promise<LoggedSearch | null> {
  const res = await ask(sessionId, `${BASE}/searches/latest?session_id=${encodeURIComponent(sessionId)}`);
  return (await json<{ search: LoggedSearch | null }>(res)).search;
}

export async function fetchCachedDepth(moment: Moment): Promise<Blob | null> {
  const res = await fetch(moment.depth_url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`depth fetch returned ${res.status}`);
  return res.blob();
}

export async function saveDepth(moment: Moment, png: Blob): Promise<void> {
  await fetch(moment.depth_url, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: png,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** The moment's photo as a Blob, for the depth model. */
export async function fetchPhoto(moment: Moment): Promise<Blob> {
  const res = await fetch(moment.image_url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`photo fetch returned ${res.status}`);
  return res.blob();
}
