// /garden?session=<id>
//
// Iris's memory as a tree of life. Every decision is a leaf, every saved
// memory a gold blossom, and new ones sprout as Iris works. Asking where
// something is, whether typed here or said out loud to the glasses through
// the phone page, flies to the matching blossom and opens that moment in 3D.
// /garden?demo shows the tree with scripted moments and nothing connected.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { XR, XROrigin, createXRStore, useXR } from "@react-three/xr";
import type { Moment } from "./api";
import { latestSearch, listMoments, memoryConfigured, search } from "./api";
import { blossomFor, type Leaf } from "./canopy";
// The depth model's library is large, so it loads after the garden is on screen.
const depth = () => import("./depth");
import { MomentScene } from "./MomentScene";
import { SafeBoundary } from "./SafeBoundary";
import { FONT_REGULAR, getTheme } from "./theme";
import { CardboardRig, requestMotionPermission } from "./Cardboard";
import { HOME, TreeScene } from "./tree/TreeScene";
import type { Vec3 } from "./tree/grow";
import { leafCenter } from "./tree/places";
import { timeAgo } from "./time";
import { useCanopy } from "./useCanopy";
import "./garden.css";

const xrStore = createXRStore({
  controller: { teleportPointer: true },
  hand: { teleportPointer: true },
  emulate: false,
});

const MOMENTS_POLL_MS = 8000;
const SEARCH_POLL_MS = 1500;
const OPEN_DELAY_MS = 2600; // let the flight to the blossom play before stepping inside
const DIORAMA_POS: Vec3 = [0, 1.5, -2.2];

const DID: Record<Leaf["kind"], string> = {
  silent: "Stayed silent",
  display: "Showed a line",
  speak: "Spoke",
  blossom: "Remembered",
};

type SpeechCtor = new () => {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
};
const Speech: SpeechCtor | undefined =
  (window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition;

function fromUrl() {
  const q = new URLSearchParams(window.location.search);
  const demo = q.has("demo");
  return { sessionId: q.get("session") ?? (demo ? "demo" : null), demo, bare: q.get("canopy") === "bare" };
}

/** Puts the screen camera straight in front of a moment, whatever angle the garden left it at. */
function FaceMoment() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: { set: (...v: number[]) => void }; update: () => void } | null;
  useEffect(() => {
    camera.position.set(DIORAMA_POS[0], DIORAMA_POS[1] + 0.2, DIORAMA_POS[2] + 2.9);
    camera.lookAt(DIORAMA_POS[0], DIORAMA_POS[1] + 0.2, DIORAMA_POS[2]);
    controls?.target.set(DIORAMA_POS[0], DIORAMA_POS[1] + 0.2, DIORAMA_POS[2]);
    controls?.update();
  }, [camera, controls]);
  return null;
}

/** In-scene "Back to the garden" for VR and Cardboard, where the HTML overlay isn't visible. */
function BackButton({ onBack, cardboard }: { onBack: () => void; cardboard: boolean }) {
  const inXR = useXR((s) => s.mode !== null);
  if (!inXR && !cardboard) return null;
  return (
    <Text
      position={[0, 0.35, -1.6]}
      font={FONT_REGULAR}
      fontSize={0.08}
      color={getTheme().glow}
      anchorX="center"
      userData={{ gazeId: "__back" }}
      onClick={onBack}
      visible
    >
      {inXR ? "Back to the garden (point and click)" : "Back to the garden (look here)"}
    </Text>
  );
}

export function Garden() {
  const { sessionId, demo, bare } = useMemo(fromUrl, []);
  const [moments, setMoments] = useState<Moment[]>([]);
  const { canopy, tie } = useCanopy(sessionId, demo, moments);

  const [foundId, setFoundId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [depthUrl, setDepthUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [hover, setHover] = useState<{ leaf: Leaf; x: number; y: number } | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [listening, setListening] = useState(false);

  const [vrSupported, setVrSupported] = useState(false);
  const [cardboard, setCardboard] = useState(false);

  const lastSearchId = useRef<number | null | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  const momentsRef = useRef<Moment[]>([]);
  momentsRef.current = moments;
  const foundMoments = useRef<Moment[]>([]); // moments a search found that the list didn't hold
  const canopyRef = useRef(canopy);
  canopyRef.current = canopy;

  const useMemory = memoryConfigured && !demo && !!sessionId;
  const byId = useCallback((id: number | null) => momentsRef.current.find((m) => m.id === id) ?? null, []);
  const blossomOf = (id: number | null) => (id === null ? null : (canopy.leaves.find((l) => l.momentId === id) ?? null));
  const selected = byId(selectedId);
  const selectedLeaf = blossomOf(selectedId);
  const open = byId(openId);

  // ------------------------------------------------------------- data

  // Memory being down is not an error here: the tree keeps growing from live decisions.
  const refresh = useCallback(async () => {
    if (!useMemory || !sessionId) return;
    try {
      const listed = await listMoments(sessionId);
      const have = new Set(listed.map((m) => m.id));
      setMoments([...listed, ...foundMoments.current.filter((m) => !have.has(m.id))]);
    } catch {
      /* try again on the next poll */
    }
  }, [sessionId, useMemory]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, MOMENTS_POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    navigator.xr?.isSessionSupported("immersive-vr").then(setVrSupported).catch(() => setVrSupported(false));
    if (useMemory) depth().then((d) => d.warmDepthModel()).catch(() => {}); // start the model download while the judge looks around
  }, [useMemory]);

  // ------------------------------------------------------------- moments

  const openMoment = useCallback((m: Moment) => {
    window.clearTimeout(openTimer.current);
    setSelectedId(m.id);
    setOpenId(m.id);
    setDepthUrl(null);
    setStatus("Building the 3D scene");
    depth()
      .then((d) => d.depthUrlFor(m, setStatus))
      .then((url) => {
        setDepthUrl(url);
        setStatus(null);
      })
      .catch(() => setStatus("Couldn't build this scene in 3D. Showing the garden instead."));
  }, []);

  const closeMoment = useCallback(() => {
    setOpenId(null);
    setDepthUrl(null);
    setStatus(null);
  }, []);

  /** A search found something, from here or from the glasses. Fly to its blossom, then step inside.
   *  found: the moment itself when the search returned it, so it can be shown even if the list doesn't hold it. */
  const showFound = useCallback(
    async (momentId: number | null, target: string, found: Moment | null = null) => {
      window.clearTimeout(openTimer.current);
      if (momentId === null) {
        setFoundId(null);
        setStatus(`Nothing in memory looks like ${target} yet.`);
        return;
      }
      if (useMemory && !byId(momentId) && !found) await refresh();
      const m = byId(momentId) ?? (found?.id === momentId ? found : null);
      if (m && !byId(momentId)) {
        foundMoments.current = [...foundMoments.current.filter((x) => x.id !== m.id), m];
        setMoments((all) => (all.some((x) => x.id === m.id) ? all : [...all, m])); // it grows a blossom to fly to
      }
      const leaf = canopyRef.current.leaves.find((l) => l.momentId === momentId);

      closeMoment();
      setFoundId(momentId);
      setSelectedId(momentId);
      const when = m?.captured_at ?? (leaf ? new Date(leaf.at).toISOString() : null);
      setStatus(when ? `Found ${target}. Seen ${timeAgo(when)}.` : `Found ${target}.`);
      if (!m) return; // a blossom with no photo behind it (demo, or memory still offline) can be flown to but not opened
      depth().then((d) => d.depthUrlFor(m)).catch(() => {}); // start depth now so it's ready on arrival
      openTimer.current = window.setTimeout(() => openMoment(m), OPEN_DELAY_MS);
    },
    [byId, refresh, closeMoment, openMoment, useMemory],
  );

  // Follow questions asked anywhere for this session.
  useEffect(() => {
    if (!useMemory || !sessionId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await latestSearch(sessionId);
        if (stopped) return;
        if (lastSearchId.current === undefined) {
          lastSearchId.current = s?.id ?? null; // ignore whatever was asked before the page opened
        } else if (s && s.id !== lastSearchId.current) {
          lastSearchId.current = s.id;
          showFound(s.moment_id, s.target);
        }
      } catch {
        /* memory is unreachable; the next poll tries again */
      }
    };
    poll();
    const t = window.setInterval(poll, SEARCH_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [sessionId, showFound, useMemory]);

  /** Without memory search, match the question against the blossoms already on the tree. */
  const askTheTree = (q: string) => {
    const leaf = blossomFor(canopyRef.current, q);
    const target = leaf?.keywords.find((w) => q.toLowerCase().includes(w)) ?? "that";
    return showFound(leaf?.momentId ?? null, target);
  };

  const ask = async (q: string) => {
    if (!sessionId || !q.trim()) return;
    setAsking(true);
    try {
      if (!useMemory) {
        await askTheTree(q);
      } else {
        const r = await search(sessionId, q.trim());
        lastSearchId.current = r.search_id ?? lastSearchId.current; // the poll shouldn't replay our own question
        await showFound(r.moment?.id ?? null, r.target, r.moment);
        if (r.moment) tie(r.moment.id, r.top.map((m) => m.id));
      }
      setQuestion("");
    } catch {
      await askTheTree(q); // memory didn't answer in time, so look through what the tree already holds
      setQuestion("");
    } finally {
      setAsking(false);
    }
  };

  const listen = () => {
    if (!Speech) return;
    const rec = new Speech();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? "";
      setQuestion(text);
      ask(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const enterCardboard = async () => {
    if (!(await requestMotionPermission())) {
      setStatus("Cardboard needs motion access. Allow it in the browser prompt and try again.");
      return;
    }
    await document.documentElement.requestFullscreen?.().catch(() => {});
    await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape").catch(() => {});
    setCardboard(true);
  };

  const exitCardboard = () => {
    setCardboard(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  /** A blossom was clicked, tapped or gazed at: select it, and a second time step inside. */
  const pick = (momentId: number) => {
    const m = byId(momentId);
    if (selectedId === momentId && m) openMoment(m);
    else setSelectedId(momentId);
  };

  const onGaze = (id: number | string) => {
    if (id === "__back") return closeMoment();
    if (typeof id === "number") pick(id);
  };

  const closeCard = () => {
    window.clearTimeout(openTimer.current);
    setSelectedId(null);
    setFoundId(null);
    setStatus(null);
  };

  // Where the Cardboard viewer's head should be.
  const cardboardEye: Vec3 = useMemo(() => {
    if (openId) return [0, 1.6, 0.3];
    const leaf = canopy.leaves.find((l) => l.momentId !== null && l.momentId === (selectedId ?? foundId));
    if (!leaf) return [0, HOME.height, HOME.distance];
    // Cardboard faces the tree from the south, so stand south of the blossom with it straight ahead.
    const p = leafCenter(leaf);
    return [p[0], p[1], p[2] + 7];
  }, [openId, selectedId, foundId, canopy.leaves]);

  // ------------------------------------------------------------- render

  if (!sessionId) {
    return (
      <div className="garden garden-empty">
        <main className="garden-empty-body">
          <h1>Memory garden</h1>
          <p>This page needs a session. Open it from the QR code on the phone page, or add ?session= and the judge's session id to the address.</p>
        </main>
      </div>
    );
  }

  const focusMoment = selectedId ?? foundId;
  const blossoms = canopy.leaves.reduce((n, l) => n + (l.kind === "blossom" ? 1 : 0), 0);
  const leaves = canopy.leaves.length - blossoms;

  return (
    <div className={`garden ${cardboard ? "is-cardboard" : ""}`}>
      <Canvas camera={{ position: [0, HOME.height, HOME.distance], fov: 60 }} dpr={[1, 1.5]}>
        <XR store={xrStore}>
          {open && depthUrl ? (
            <>
              <color attach="background" args={[getTheme().duskDeep]} />
              <ambientLight intensity={1} />
              <SafeBoundary key={open.id} onError={() => setStatus("This moment's photo couldn't be loaded. Go back and try another.")}>
                <Suspense fallback={null}>
                  <MomentScene moment={open} depthUrl={depthUrl} position={DIORAMA_POS} />
                </Suspense>
              </SafeBoundary>
              <Suspense fallback={null}>
                <BackButton onBack={closeMoment} cardboard={cardboard} />
              </Suspense>
              <XROrigin position={[0, 0, 0]} />
              {!cardboard && <FaceMoment />}
              {!cardboard && (
                <OrbitControls
                  makeDefault
                  target={[DIORAMA_POS[0], DIORAMA_POS[1] + 0.2, DIORAMA_POS[2]]}
                  enablePan={false}
                  minDistance={1.2}
                  maxDistance={4}
                  minAzimuthAngle={-0.7}
                  maxAzimuthAngle={0.7}
                  minPolarAngle={Math.PI / 2 - 0.5}
                  maxPolarAngle={Math.PI / 2 + 0.35}
                />
              )}
            </>
          ) : (
            <Suspense fallback={null}>
              <TreeScene
                canopy={canopy}
                focusId={focusMoment === null ? null : `m:${focusMoment}`}
                foundId={foundId === null ? null : `m:${foundId}`}
                cardboard={cardboard}
                standing={!bare}
                onHover={(leaf, x, y) => setHover(leaf ? { leaf, x, y } : null)}
                onPick={(leaf) => leaf.momentId !== null && pick(leaf.momentId)}
              />
            </Suspense>
          )}
          {cardboard && <CardboardRig eye={cardboardEye} onGaze={onGaze} />}
        </XR>
      </Canvas>

      {!cardboard && (
        <div className="overlay">
          <header className="masthead">
            <span className="wordmark">Iris</span>
            <span className="count">
              {leaves === 1 ? "1 moment" : `${leaves} moments`} · {blossoms === 1 ? "1 memory" : `${blossoms} memories`}
            </span>
          </header>

          {!openId && (
            <ul className="legend" aria-label="What the leaves mean">
              <li className="faint"><i />stayed silent</li>
              <li className="bright"><i />spoke</li>
              <li className="gold"><i />remembered</li>
            </ul>
          )}
          {demo && !openId && <p className="demo-tag">Demo: scripted moments, nothing connected</p>}

          {hover && !openId && (
            <div
              className={`leaf-card ${hover.leaf.kind === "blossom" ? "blossom" : ""} ${hover.x > window.innerWidth * 0.62 ? "flip" : ""}`}
              style={{ left: hover.x, top: hover.y }}
              role="status"
            >
              <p className="did">
                {DID[hover.leaf.kind]} <span>· {timeAgo(new Date(hover.leaf.at).toISOString())}</span>
              </p>
              {hover.leaf.line && <p className="line">{hover.leaf.kind === "blossom" ? hover.leaf.line : `“${hover.leaf.line}”`}</p>}
              {hover.leaf.kind !== "blossom" && hover.leaf.reason && <p className="why">{hover.leaf.reason}</p>}
            </div>
          )}

          {selectedLeaf && !open && (
            <section className="moment-card" aria-live="polite">
              {selected && <img className="photo" src={selected.image_url} alt="" />}
              <p className="when">Seen {timeAgo(new Date(selectedLeaf.at).toISOString())}</p>
              <p className="what">{selectedLeaf.line}</p>
              <div className="actions">
                {selected && <button className="primary" onClick={() => openMoment(selected)}>Step inside</button>}
                <button onClick={closeCard}>Close</button>
              </div>
            </section>
          )}

          {/* The 3D scene can take a while to build. Until it is ready, the photo and what was seen are already here. */}
          {open && !depthUrl && (
            <section className="moment-card" aria-live="polite">
              <img className="photo" src={open.image_url} alt="" />
              <p className="when">Seen {timeAgo(open.captured_at)}</p>
              <p className="what">{open.description}</p>
              <div className="actions">
                <button onClick={closeMoment}>Back to the garden</button>
              </div>
            </section>
          )}

          {openId && !(open && !depthUrl) && (
            <div className="open-bar">
              <button onClick={closeMoment}>Back to the garden</button>
            </div>
          )}

          {status && <p className="status" aria-live="polite">{status}</p>}

          <form
            className="ask"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <label htmlFor="ask-input" className="visually-hidden">Ask where something is</label>
            <input
              id="ask-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Where did I leave my phone?"
              autoComplete="off"
            />
            {Speech && (
              <button type="button" onClick={listen} disabled={listening} aria-label="Ask out loud">
                {listening ? "Listening" : "Speak"}
              </button>
            )}
            <button type="submit" className="primary" disabled={asking || !question.trim()}>
              {asking ? "Looking" : "Find it"}
            </button>
          </form>

          <div className="modes">
            {vrSupported && <button onClick={() => xrStore.enterVR()}>Enter VR</button>}
            <button onClick={enterCardboard}>Cardboard</button>
          </div>
        </div>
      )}

      {cardboard && (
        <button className="exit-cardboard" onClick={exitCardboard}>Exit Cardboard</button>
      )}
    </div>
  );
}
