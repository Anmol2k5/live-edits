export type CameraErrorKind = "denied" | "not-found" | "in-use" | "unknown";

export type CameraResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; error: CameraErrorKind; message: string };

function classifyError(err: unknown): { error: CameraErrorKind; message: string } {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return { error: "denied", message: "Camera permission was denied." };
      case "NotFoundError":
        return { error: "not-found", message: "No camera found on this device." };
      case "NotReadableError":
      case "AbortError":
        return { error: "in-use", message: "Camera is in use by another application." };
      default:
        return { error: "unknown", message: err.message };
    }
  }
  return { error: "unknown", message: String(err) };
}

export async function requestCamera(
  deviceId?: string
): Promise<CameraResult> {
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
