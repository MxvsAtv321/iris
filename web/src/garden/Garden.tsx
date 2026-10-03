// /garden?session=<id>
//
// The judge's own memories as a garden. Asking where something is, whether
// typed here or said out loud to the glasses through the phone page, makes
// the matching bud bloom, glides to it, and opens that moment in 3D.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { XR, XROrigin, createXRStore, useXR } from "@react-three/xr";
import type { Moment } from "./api";
import { latestSearch, listMoments, memoryConfigured, search } from "./api";
// The depth model's library is large, so it loads after the garden is on screen.
const depth = () => import("./depth");
import { GardenScene } from "./GardenScene";
import { MomentScene } from "./MomentScene";
import { SafeBoundary } from "./SafeBoundary";
import { FONT_REGULAR, getTheme } from "./theme";
import { CardboardRig, requestMotionPermission } from "./Cardboard";
import { budPosition, type Vec3 } from "./layout";
import { timeAgo } from "./time";
import "./garden.css";

const xrStore = createXRStore({
  controller: { teleportPointer: true },
  hand: { teleportPointer: true },
  emulate: false,
});

const MOMENTS_POLL_MS = 8000;
const SEARCH_POLL_MS = 1500;
const OPEN_DELAY_MS = 1800; // let the glide to the bud play before stepping inside
const DIORAMA_POS: Vec3 = [0, 1.5, -2.2];

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

function sessionFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("session");
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
  const sessionId = useMemo(sessionFromUrl, []);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [foundId, setFoundId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [depthUrl, setDepthUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [listening, setListening] = useState(false);

  const [vrSupported, setVrSupported] = useState(false);
  const [cardboard, setCardboard] = useState(false);

  const lastSearchId = useRef<number | null | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  const momentsRef = useRef<Moment[]>([]);
  momentsRef.current = moments;

  const byId = useCallback((id: number | null) => momentsRef.current.find((m) => m.id === id) ?? null, []);
  const selected = byId(selectedId);
  const open = byId(openId);

  // ------------------------------------------------------------- data

  const refresh = useCallback(async () => {
    if (!sessionId || !memoryConfigured) return;
    try {
      const list = await listMoments(sessionId);
      setMoments(list);
      setError(null);
    } catch {
      setError("Can't reach memory. Check that the memory function is deployed and VITE_MEMORY_URL points at it.");
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, MOMENTS_POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!sessionId || !memoryConfigured) return;
    navigator.xr?.isSessionSupported("immersive-vr").then(setVrSupported).catch(() => setVrSupported(false));
    depth().then((d) => d.warmDepthModel()).catch(() => setStatus("Depth preview is unavailable. You can still browse memories.")); // start the model download while the judge looks around
  }, [sessionId]);

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

  /** A search found something, from here or from the glasses. Bloom, glide, then step inside. */
  const showFound = useCallback(
    async (momentId: number | null, target: string) => {
      if (!momentId) {
        setFoundId(null);
        setStatus(`Nothing in memory looks like ${target} yet.`);
        return;
      }
      if (!byId(momentId)) await refresh();
      const m = byId(momentId);
      if (!m) return;

      closeMoment();
      setFoundId(m.id);
      setSelectedId(m.id);
      setStatus(`Found ${target}. Seen ${timeAgo(m.captured_at)}.`);
      depth().then((d) => d.depthUrlFor(m)).catch(() => {}); // start depth now so it's ready on arrival
      openTimer.current = window.setTimeout(() => openMoment(m), OPEN_DELAY_MS);
    },
    [byId, refresh, closeMoment, openMoment],
  );

  // Follow questions asked anywhere for this session.
  useEffect(() => {
    if (!sessionId || !memoryConfigured) return;
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
        /* the moments poll reports connection problems */
      }
    };
    poll();
    const t = window.setInterval(poll, SEARCH_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [sessionId, showFound]);

  const ask = async (q: string) => {
    if (!sessionId || !q.trim()) return;
    setAsking(true);
    try {
      const r = await search(sessionId, q.trim());
      lastSearchId.current = r.search_id ?? lastSearchId.current; // the poll shouldn't replay our own question
      await showFound(r.moment?.id ?? null, r.target);
      setQuestion("");
    } catch {
      setStatus("Memory didn't answer in time. Ask again.");
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

  const onGaze = (id: number | string) => {
    if (id === "__back") return closeMoment();
    if (typeof id !== "number") return;
    const m = byId(id);
    if (!m) return;
    if (selectedId === m.id) openMoment(m);
    else setSelectedId(m.id);
  };

  // Where the Cardboard viewer's head should be.
  const cardboardEye: Vec3 = useMemo(() => {
    if (openId) return [0, 1.6, 0.3];
    const i = moments.findIndex((m) => m.id === (selectedId ?? foundId));
    if (i < 0) return [0, 1.6, 1.5];
    const p = budPosition(i, moments.length);
    return [p[0] * 0.6, 1.6, p[2] + 1.4];
  }, [openId, selectedId, foundId, moments]);

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
  if (!memoryConfigured) {
    return (
      <div className="garden garden-empty">
        <main className="garden-empty-body">
          <h1>Memory garden</h1>
          <p>Set VITE_MEMORY_URL in the root .env to the memory function's address, then restart the dev server.</p>
        </main>
      </div>
    );
  }

  return (
    <div className={`garden ${cardboard ? "is-cardboard" : ""}`}>
      <Canvas camera={{ position: [0, 1.5, 1.1], fov: 60 }} dpr={[1, 2]}>
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
            <GardenScene
              moments={moments}
              foundId={foundId}
              selectedId={selectedId}
              onSelect={(m) => (selectedId === m.id ? openMoment(m) : setSelectedId(m.id))}
              cardboard={cardboard}
            />
          )}
          {cardboard && <CardboardRig eye={cardboardEye} onGaze={onGaze} />}
        </XR>
      </Canvas>

      {!cardboard && (
        <div className="overlay">
          <header className="masthead">
            <span className="wordmark">Iris</span>
            <span className="count">
              {loaded ? (moments.length === 1 ? "1 moment remembered" : `${moments.length} moments remembered`) : "Opening memory"}
            </span>
          </header>

          {error && <p className="notice notice-error">{error}</p>}
          {!error && loaded && moments.length === 0 && (
            <p className="notice">Nothing remembered yet. Put on the glasses and look around, and moments will grow here.</p>
          )}

          {selected && !open && (
            <section className="moment-card" aria-live="polite">
              <p className="when">Seen {timeAgo(selected.captured_at)}</p>
              <p className="what">{selected.description}</p>
              <div className="actions">
                <button className="primary" onClick={() => openMoment(selected)}>Step inside</button>
                <button onClick={() => setSelectedId(null)}>Close</button>
              </div>
            </section>
          )}

          {openId && (
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
