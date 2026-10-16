export interface RelayMediaItem {
  name: string;
  bytes: number;
  kind: "video" | "audio" | "image";
}

export class MediaTransferError extends Error {  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "MediaTransferError";
  }
}

/** Returned by the relay when the name is already taken. */
export interface MediaConflict {
  name: string;
  bytes: number;
}

function baseOf(relayBase: string): string {
  return relayBase.replace(/\/+$/, "");
}

async function readError(response: Response, fallback: string): Promise<MediaTransferError> {
  let code = fallback;
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === "string" && body.error) code = body.error;
  } catch {
    // Non-JSON error bodies keep the fallback code.
  }
  const messages: Record<string, string> = {
    unauthorized: "Relay rejected the publish token.",
    "invalid filename": "That filename is not allowed on the relay.",
    "content does not match the filename":
      "File content does not match its extension.",
    "empty file": "Empty files cannot be uploaded.",
    "file too large": "Files over 50 MB are rejected by the relay.",
    exists: "A file with that name is already on the relay.",
    "upload in progress": "That file is already uploading.",
    "missing media file": "File not found on the relay.",
    "not found": "File not found on the relay.",
  };
  return new MediaTransferError(
    messages[code] ?? `Relay returned HTTP ${response.status}.`,
    response.status,
    code
  );
}

/**
 * Stream a file to the loopback relay (publish-token auth). The body
 * streams — the client never buffers the whole file to build the request.
 */
export async function uploadMedia(
  relayBase: string,
  publishToken: string,
  file: { name: string; type?: string },
  body: BodyInit,
  timeoutMs = 60000
): Promise<RelayMediaItem> {
  if (!publishToken.trim()) throw new Error("Enter the relay publish token.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // File/Blob bodies carry a known length, so no streaming duplex flag is
    // needed; the bytes still travel without client-side re-buffering.
    const response = await fetch(
      `${baseOf(relayBase)}/api/media/${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + publishToken.trim(),
          ...(file.type ? { "Content-Type": file.type } : {}),
        },
        body,
        signal: controller.signal,
      }
    );
    if (response.status === 201) {
      return (await response.json()) as RelayMediaItem;
    }
    throw await readError(response, "upload failed");
  } finally {
    clearTimeout(timeout);
  }
}

/** Explicit, confirmed replacement path: delete first, then upload again. */
export async function deleteRelayMedia(
  relayBase: string,
  publishToken: string,
  name: string
): Promise<void> {
  if (!publishToken.trim()) throw new Error("Enter the relay publish token.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `${baseOf(relayBase)}/api/media/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer " + publishToken.trim() },
        signal: controller.signal,
      }
    );
    if (response.ok) return;
    throw await readError(response, "delete failed");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRelayInventory(
  relayBase: string,
  publishToken: string
): Promise<RelayMediaItem[]> {
  if (!publishToken.trim()) throw new Error("Enter the relay publish token.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseOf(relayBase)}/api/media`, {
      headers: { Authorization: "Bearer " + publishToken.trim() },
      signal: controller.signal,
    });
    if (!response.ok) throw await readError(response, "inventory failed");
    const body = (await response.json()) as { media?: RelayMediaItem[] };
    return body.media ?? [];
  } finally {
    clearTimeout(timeout);
  }
}
