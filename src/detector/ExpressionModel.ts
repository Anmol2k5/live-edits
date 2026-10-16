import * as faceapi from "@vladmandic/face-api";

export interface ExpressionScores {
  neutral: number;
  happy: number;
  sad: number;
  surprised: number;
  angry: number;
  disgusted: number;
  fearful: number;
}

const EMPTY_SCORES: ExpressionScores = {
  neutral: 0,
  happy: 0,
  sad: 0,
  surprised: 0,
  angry: 0,
  disgusted: 0,
  fearful: 0,
};

let modelsLoaded = false;
let loadPromise: Promise<void> | null = null;

export async function loadModels(modelsPath = "/models"): Promise<void> {
  if (modelsLoaded) return;
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromUri(modelsPath);
    await faceapi.nets.faceExpressionNet.loadFromUri(modelsPath);
    modelsLoaded = true;
  })();
  try {
    await loadPromise;
  } catch (err) {
    // Allow a later retry — do not cache a rejected load.
    loadPromise = null;
    throw err;
  }
}

/** Test-only reset for the module-level load cache. */
export function __resetModelCacheForTests(): void {
  modelsLoaded = false;
  loadPromise = null;
}

export function isReady(): boolean {
  return modelsLoaded;
}

const DETECT_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,
  scoreThreshold: 0.5,
});

export async function detect(
  video: HTMLVideoElement
): Promise<ExpressionScores> {
  if (!modelsLoaded) return { ...EMPTY_SCORES };
  if (video.readyState < 2) return { ...EMPTY_SCORES };

  try {
    const result = await faceapi
      .detectSingleFace(video, DETECT_OPTIONS)
      .withFaceExpressions();

    if (!result) return { ...EMPTY_SCORES };

  const e = result.expressions;
  return {
    neutral: e.neutral,
    happy: e.happy,
    sad: e.sad,
    surprised: e.surprised,
    angry: e.angry,
    disgusted: e.disgusted,
    fearful: e.fearful,
  };
  } catch {
    // Inference failure (e.g. torn-down video, WebGL error) is treated
    // as "no face" so the polling loop survives. Callers needing the
    // raw error should call face-api directly.
    return { ...EMPTY_SCORES };
  }
}
