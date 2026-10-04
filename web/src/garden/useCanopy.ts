// Keeps the tree's leaves up to date. Decisions arrive live from the brain
// over the WebSocket and each sprouts a leaf. Saved memories become blossoms,
// from the same stream and from the memory list when memory answers. If
// either source is down the tree simply grows from the other; nothing here
// ever raises an error.

import { useCallback, useEffect, useRef, useState } from "react";
import { useFeed } from "../useFeed";
import type { Moment } from "./api";
import { EMPTY, grow, sproutFromEvent, sproutFromMoment, tieByMeaning, type Canopy, type Sprout } from "./canopy";
import { DEMO_EVERY_MS, DEMO_START, demoSprout } from "./demo";
import { REAL_SLOTS } from "./tree/places";

const SAVE_EVERY_MS = 4000;
const key = (session: string) => `iris-garden:${session}`;

/** The tree as it was when this session's page was last open, so a reload doesn't strip it bare. */
function restore(session: string): Canopy {
  try {
    const saved = JSON.parse(localStorage.getItem(key(session)) ?? "null") as Canopy | null;
    if (!saved || !Array.isArray(saved.leaves) || !Array.isArray(saved.threads)) return EMPTY;
    return {
      leaves: saved.leaves.filter((l) => l.slot < REAL_SLOTS).map((l) => ({ ...l, born: 0 })),
      threads: saved.threads.map((t) => ({ ...t, born: 0 })),
      sprouted: saved.sprouted,
    };
  } catch {
    return EMPTY;
  }
}

function demoStart(): Canopy {
  const now = Date.now();
  const sprouts = Array.from({ length: DEMO_START }, (_, n) => demoSprout(n, now - (DEMO_START - n) * DEMO_EVERY_MS));
  return grow(EMPTY, sprouts, 0, REAL_SLOTS);
}

export function useCanopy(session: string | null, demo: boolean, moments: Moment[]) {
  const [canopy, setCanopy] = useState<Canopy>(() => (demo ? demoStart() : session ? restore(session) : EMPTY));

  const sprout = useCallback((sprouts: Sprout[], live = true) => {
    setCanopy((c) => grow(c, sprouts, live ? performance.now() : 0, REAL_SLOTS));
  }, []);

  // Live decisions, answers and saved memories. In demo mode the feed makes no connection.
  useFeed(session ?? "", demo, (event) => {
    if (demo) return;
    const s = sproutFromEvent(event);
    if (s) sprout([s]);
  });

  useEffect(() => {
    if (!demo) return;
    let n = DEMO_START;
    const t = window.setInterval(() => sprout([demoSprout(n++, Date.now())]), DEMO_EVERY_MS);
    return () => window.clearInterval(t);
  }, [demo, sprout]);

  // Memories that were saved before the page opened are simply there; later ones sprout.
  const listed = useRef(false);
  useEffect(() => {
    if (demo || moments.length === 0) return;
    sprout(moments.map(sproutFromMoment), listed.current);
    listed.current = true;
  }, [demo, moments, sprout]);

  const latest = useRef(canopy);
  latest.current = canopy;
  useEffect(() => {
    if (demo || !session) return;
    let saved: Canopy | null = null;
    const save = () => {
      if (saved === latest.current) return;
      saved = latest.current;
      try {
        localStorage.setItem(key(session), JSON.stringify(saved));
      } catch {
        /* a full or blocked store only means the tree regrows from live events */
      }
    };
    const t = window.setInterval(save, SAVE_EVERY_MS);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [demo, session]);

  /** Memory search found a moment: thread it to the moments closest in meaning. */
  const tie = useCallback((momentId: number, closest: number[]) => {
    setCanopy((c) => tieByMeaning(c, momentId, closest, performance.now()));
  }, []);

  return { canopy, tie };
}
