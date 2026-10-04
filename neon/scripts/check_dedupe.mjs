// Checks the duplicate rule in the database (save_memory_if_new in db/schema.sql) against twelve cases.
// Everything happens in one transaction that is rolled back, so nothing is left behind.
//
//   cd neon && node scripts/check_dedupe.mjs      (needs .env.local, which `npm run deploy` writes)
import fs from "node:fs";
import pg from "pg";

const local = new URL("../.env.local", import.meta.url);
const env = Object.fromEntries(
  fs.readFileSync(local, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const db = new pg.Client({ connectionString: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL });
await db.connect();

const vec = (seed, mix = 0) => { const v = []; for (let i = 0; i < 1536; i++) v.push(Math.sin(seed * (i + 1)) + mix * Math.sin(7.3 * (i + 1))); return JSON.stringify(v); };
const sim = async (a, b) => (await db.query('select 1 - ($1::vector <=> $2::vector) as s', [a, b])).rows[0].s;
const A = vec(1.0), A2 = vec(1.0, 0.12), A3 = vec(1.0, 0.45), B = vec(2.0);
console.log('word similarities: near-identical', (await sim(A, A2)).toFixed(3), ' reworded', (await sim(A, A3)).toFixed(3), ' different', (await sim(A, B)).toFixed(3));
const H = '5b1b23c327033333', Hnoise = '5b1b23c327033330', Hshift = '5b1b23c3270333cc', Hfar = '068c3049918d0c0c';
const bits = (a, b) => [...(BigInt('0x' + a) ^ BigInt('0x' + b)).toString(2)].filter(c => c === '1').length;
const cases = [
  ['first frame of a session', A, H, 'saved'],
  ['same picture, same words', A, H, 'same_image'],
  ['same picture through noise, reworded', A3, Hnoise, 'same_image'],
  ['camera moved a little, same words', A2, Hshift, 'same_scene'],
  ['camera moved a little, different words', B, Hshift, 'saved'],
  ['back to the first view for the next rows', A, H, 'saved'],
  ['a question about the scene just saved: same picture, different words', B, H, 'saved'],
  ['back again', A, H, 'saved'],
  ['a different scene described the same way', A, Hfar, 'saved'],
  ['no hash sent, same words (old client)', A, null, 'same_description'],
  ['no hash sent, different words', B, null, 'saved'],
  ['a malformed hash is treated as not sent', B, 'xyz', 'same_description'],
];
await db.query('begin');
let ok = true, t = Date.now();
for (const [name, emb, hash, want] of cases) {
  const r = (await db.query('select id, skipped from save_memory_if_new($1, $2, $3, $4::vector, 0.95, $5, $6)', ['dedupe-selftest', 'none', name, emb, new Date(t += 1000), hash])).rows[0];
  const got = r.id !== null ? 'saved' : r.skipped;
  if (got !== want) ok = false;
  console.log((got === want ? 'ok   ' : 'FAIL ') + name.padEnd(70) + got + (got === want ? '' : ` (wanted ${want})`));
}
console.log('distances: noise', bits(H, Hnoise), 'shift', bits(H, Hshift), 'far', bits(H, Hfar));
await db.query('rollback');
const left = (await db.query("select count(*)::int as n from memories where session_id = 'dedupe-selftest'")).rows[0].n;
console.log(ok ? 'ALL OK' : 'SOME FAILED', '| rows left behind:', left);
await db.end();
process.exit(ok ? 0 : 1);
