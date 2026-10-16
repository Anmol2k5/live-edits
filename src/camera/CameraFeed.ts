export type CameraErrorKind = "denied" | "not-found" | "in-use" | "unknown";

export type CameraResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; error: CameraErrorKind; message: string };

function classifyError(err: unknown): { error: CameraErrorKind; message: string } {
  // Most browsers reject with a DOMException, but some (notably older
  // Chrome for OverconstrainedError) use their own error shapes — read
  // `name`/`message` structurally instead of relying on instanceof.
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : err instanceof DOMException
        ? err.name
        : "";
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return { error: "denied", message: "Camera permission was denied." };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { error: "not-found", message: "No camera found on this device." };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { error: "in-use", message: "Camera is in use by another application." };
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return { error: "not-found", message: `Requested camera is unavailable (${message}).` };
    default:
      return { error: "unknown", message };
  }
}

export async function requestCamera(
  deviceId?: string
): Promise<CameraResult> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return {
      ok: false,
      error: "unknown",
      message: "Camera is not supported in this browser or context (secure context required).",
    };
  }
  try {
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, ...classifyError(err) };
  }
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
