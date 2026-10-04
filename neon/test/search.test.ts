// Run with `npm test`. Covers the rule that picks which moment answers a search.
import assert from "node:assert/strict";
import { test } from "node:test";
import { guessTarget, pickMoment } from "../functions/memory.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 21, minute));
const row = (id: number, minute: number, similarity: number, keyword_match = false) => ({
  id,
  captured_at: at(minute),
  similarity,
  keyword_match,
});

test("a moment that names the object beats a newer one that only resembles it", () => {
  // Measured on real frames: asking for the brick wall, the smoke detector frame
  // scored 0.32 and a blurry ceiling 0.39, both newer than the wall itself.
  const rows = [row(2, 1, 0.3), row(3, 2, 0.57, true), row(4, 3, 0.32), row(7, 4, 0.39)];
  assert.equal(pickMoment(rows, 0.45)?.id, 3);
});

test("among moments that name the object, the newest wins", () => {
  const rows = [row(1, 1, 0.7, true), row(2, 2, 0.5, true), row(3, 3, 0.6)];
  assert.equal(pickMoment(rows, 0.45)?.id, 2);
});

test("a keyword match counts even below the similarity floor", () => {
  assert.equal(pickMoment([row(1, 1, 0.2, true), row(2, 2, 0.44)], 0.45)?.id, 1);
});

test("with no keyword match, the newest moment above the floor wins", () => {
  const rows = [row(1, 1, 0.8), row(2, 2, 0.5), row(3, 3, 0.45), row(4, 4, 0.3)];
  assert.equal(pickMoment(rows, 0.45)?.id, 2);
});

test("nothing above the floor and no keyword match is not a match", () => {
  assert.equal(pickMoment([row(1, 1, 0.22), row(2, 2, 0.39)], 0.45), undefined);
  assert.equal(pickMoment([], 0.45), undefined);
});

test("the object comes out of the question", () => {
  assert.equal(guessTarget("where did I see the brick wall?"), "brick wall");
  assert.equal(guessTarget("where is the smoke detector?"), "smoke detector");
  assert.equal(guessTarget("where did I leave my phone?"), "phone");
});
