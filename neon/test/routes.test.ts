// Run with `npm test`. Route checks that need no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../functions/memory.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

test("a moment id that isn't a number is a 404, not a 503", async () => {
  for (const id of ["abc", "12abc", "1.5", "-1", "9".repeat(30)]) {
    for (const [method, part, body] of [
      ["GET", "image", undefined],
      ["GET", "depth", undefined],
      ["PUT", "depth", PNG],
    ] as const) {
      const r = await app.request(`/api/memory/moments/${id}/${part}?session_id=test`, { method, body });
      assert.equal(r.status, 404, `${method} /moments/${id}/${part}`);
      assert.deepEqual(await r.json(), { error: "not found" });
    }
  }
});

test("a missing session is still a 400", async () => {
  const r = await app.request("/api/memory/moments/abc/image");
  assert.equal(r.status, 400);
});
