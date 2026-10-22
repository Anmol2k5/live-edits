import { useMemo, useRef, useState } from "react";
import {
  searchMedia,
  type MediaKind,
  type MediaRecord,
} from "./mediaLibrary";
import type { RelayMediaItem } from "../relay/mediaTransfer";
import type { TransferStatus } from "./ReactionEditor";
import { ConfirmButton } from "./PackToolbar";

interface MediaLibraryPanelProps {
  records: MediaRecord[];
  usage: Map<string, number>;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  onImportFiles: (files: FileList) => void;
  onRemove: (name: string) => void;
  importError: string | null;
  relayInventory?: RelayMediaItem[] | null;
  transferStates?: Record<string, TransferStatus>;
  relayNote?: string | null;
  canUpload?: boolean;
  onUpload?: (name: string) => void;
  onReplaceRelay?: (name: string) => void;
  onDeleteRelay?: (name: string) => void;
  onRefreshRelay?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeMeta(record: MediaRecord): string {
  const dims =
    record.width !== null && record.height !== null
      ? ` · ${record.width}×${record.height}`
      : "";
  const dur =
    record.durationMs !== null ? ` · ${(record.durationMs / 1000).toFixed(1)}s` : "";
  if (!record.available) return "missing file — reimport to preview";
  if (record.width === null && record.durationMs === null && dims === "" && dur === "") {
    return "metadata unavailable";
  }
  return `${dims}${dur}`.replace(/^ · /, "");
}

export function MediaLibraryPanel(props: MediaLibraryPanelProps) {
  const {
    records,
    usage,
    selectedName,
    onSelect,
    onImportFiles,
    onRemove,
    importError,
    relayInventory = null,
    transferStates = {},
    relayNote = null,
    canUpload = false,
    onUpload,
    onReplaceRelay,
    onDeleteRelay,
    onRefreshRelay,
  } = props;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MediaKind | "all">("all");
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => searchMedia(records, query, kind),
    [records, query, kind]
  );

  return (
    <section className="editor-panel" aria-label="Media library">
      <h2>Media</h2>
      <div className="editor-row">
        <input
          aria-label="Search media"
          placeholder="Search name, size, kind…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter by kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as MediaKind | "all")}
        >
          <option value="all">All</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="audio">Audio</option>
        </select>
      </div>
      <div className="editor-row">
        <button type="button" onClick={() => fileRef.current?.click()}>
          Import files
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept="image/*,video/*,audio/*"
          aria-label="Import media files"
          onChange={(e) => {
            if (e.target.files) onImportFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="editor-hint">PNG/JPEG/WebP/GIF · MP4/WebM · MP3/WAV/OGG · ≤50 MB</span>
      </div>
      {importError && (
        <p className="editor-error" role="alert">
          {importError}
        </p>
      )}
      {!canUpload && records.length > 0 && (
        <p className="editor-hint">
          Paste the relay publish token (OBS Bridge panel) to send media to OBS.
          Imports stay local until then.
        </p>
      )}
      {records.length === 0 ? (
        <p className="editor-empty">
          No media yet. Import a file to create your first effect — with a
          relay token imports stream to OBS automatically, otherwise use Send
          to relay below.
        </p>
      ) : filtered.length === 0 ? (
        <p className="editor-empty">No media matches this filter.</p>
      ) : (
        <ul className="editor-media-list">
          {filtered.map((record) => {
            const used = usage.get(record.name) ?? 0;
            const selected = selectedName === record.name;
            const transfer = transferStates[record.name] ?? { state: "idle" as const };
            const onRelay =
              transfer.state === "on-relay" ||
              (relayInventory?.some((m) => m.name === record.name) ?? false);
            return (
              <li
                key={record.name}
                className={selected ? "editor-media--selected" : undefined}
              >
                <button
                  type="button"
                  className="editor-media__select"
                  onClick={() => onSelect(selected ? null : record.name)}
                  aria-pressed={selected}
                  title={record.name}
                >
                  <span className="editor-media__kind">{record.kind}</span>
                  <span className="editor-media__name">{record.name}</span>
                  <span className="editor-media__meta">
                    {formatBytes(record.bytes)}
                    {describeMeta(record) ? ` · ${describeMeta(record)}` : ""}
                    {used > 0 ? ` · used by ${used}` : " · unused"}
                    {transfer.state === "uploading"
                      ? " · sending…"
                      : onRelay
                        ? " · on relay"
                        : canUpload
                          ? " · local only"
                          : ""}
                  </span>
                </button>
                {transfer.state === "error" && transfer.message && (
                  <p className="editor-error" role="alert">
                    {transfer.message}
                  </p>
                )}
                {transfer.state === "conflict" && (
                  <p className="editor-error" role="alert">
                    {transfer.message}
                  </p>
                )}
                <div className="editor-row">
                  {used > 0 ? (
                    <ConfirmButton
                      label="Remove"
                      armLabel={`Remove (used by ${used})`}
                      title={`${record.name} is used by ${used} effect(s)`}
                      onConfirm={() => onRemove(record.name)}
                    />
                  ) : (
                    <button type="button" onClick={() => onRemove(record.name)}>
                      Remove
                    </button>
                  )}
                  {!onRelay && transfer.state !== "uploading" && (
                    <button
                      type="button"
                      onClick={() => onUpload?.(record.name)}
                      disabled={!canUpload}
                      title={
                        canUpload
                          ? "Stream this file to the relay"
                          : "Paste the relay publish token first"
                      }
                    >
                      Send to relay
                    </button>
                  )}
                  {transfer.state === "conflict" && (
                    <ConfirmButton
                      label="Replace on relay"
                      armLabel="Confirm replace"
                      title="Delete the relay copy first, then upload this file"
                      onConfirm={() => onReplaceRelay?.(record.name)}
                    />
                  )}
                  {onRelay && (
                    <ConfirmButton
                      label="Delete from relay"
                      armLabel={
                        used > 0 ? `Confirm delete (used by ${used})` : "Confirm delete"
                      }
                      title="Remove the relay copy; saved effects using it will fail until re-uploaded"
                      onConfirm={() => onDeleteRelay?.(record.name)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="editor-row">
        <button type="button" onClick={() => onRefreshRelay?.()} disabled={!canUpload}>
          Refresh relay files
        </button>
        <span className="editor-hint">
          {relayInventory === null
            ? canUpload
              ? "Relay files not loaded yet."
              : "Relay files need the publish token."
            : relayInventory.length === 0
              ? "No files on the relay yet."
              : `On relay: ${relayInventory.map((m) => m.name).join(", ")}`}
        </span>
      </div>
      {relayNote && (
        <p className="editor-error" role="alert">
          {relayNote}
        </p>
      )}
    </section>
  );
}
