// The depth step. Turns a moment's photo into a depth map with Depth Anything
// V2 Small, running in the browser, so no server or laptop is involved.
//
// Order of preference for each moment
//   1. already in memory this session
//   2. cached in Neon by an earlier viewer (GET depth_url)
//   3. computed here, then cached back to Neon for next time
//
// The model is a few dozen MB and downloads once per device, then the browser
// keeps it. On a laptop a photo takes around a second. On a headset or phone
// expect a few seconds, which is why the garden starts depth for a searched
// moment the moment the search comes back.

import { pipeline, RawImage } from "@huggingface/transformers";
import { fetchCachedDepth, fetchPhoto, saveDepth, type Moment } from "./api";

const MODEL = "onnx-community/depth-anything-v2-small";

export type DepthStatus = (message: string) => void;

type Estimator = (image: RawImage) => Promise<{ depth: RawImage }>;

let estimator: Promise<Estimator> | null = null;
const urls = new Map<number, Promise<string>>();

function loadEstimator(onStatus?: DepthStatus): Promise<Estimator> {
  if (estimator) return estimator;

  const progress = (p: { status?: string; progress?: number }) => {
    if (p.status === "progress" && typeof p.progress === "number") {
      onStatus?.(`Downloading the depth model, ${Math.round(p.progress)}%`);
    }
  };
  const make = (device: "webgpu" | "wasm") =>
    pipeline("depth-estimation", MODEL, { device, progress_callback: progress }) as unknown as Promise<Estimator>;

  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  estimator = (hasWebGPU ? make("webgpu").catch(() => make("wasm")) : make("wasm")).catch((err) => {
    estimator = null; // allow a retry
    throw err;
  });
  return estimator;
}

async function computeDepth(moment: Moment, onStatus?: DepthStatus): Promise<Blob> {
  const run = await loadEstimator(onStatus);
  onStatus?.("Building the 3D scene");
  const image = await RawImage.fromBlob(await fetchPhoto(moment)); // our fetch, so it has a timeout
  const { depth } = await run(image);
  return (await depth.toBlob("image/png")) as Blob;
}

/** Returns an object URL for the moment's depth map, computing it only if needed. */
export function depthUrlFor(moment: Moment, onStatus?: DepthStatus): Promise<string> {
  const existing = urls.get(moment.id);
  if (existing) return existing;

  const job = (async () => {
    const cached = await fetchCachedDepth(moment).catch(() => null);
    if (cached) return URL.createObjectURL(cached);

    const png = await computeDepth(moment, onStatus);
    saveDepth(moment, png).catch((err) => console.warn("could not cache depth map", err));
    return URL.createObjectURL(png);
  })();

  urls.set(moment.id, job);
  job.catch(() => urls.delete(moment.id));
  return job;
}

/** Start loading the model early, while the judge is still looking at the garden. */
export function warmDepthModel(onStatus?: DepthStatus) {
  loadEstimator(onStatus).catch(() => {});
}
