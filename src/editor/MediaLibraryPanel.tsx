import { useMemo, useRef, useState } from "react";
import {
  searchMedia,
  type MediaKind,
  type MediaRecord,
} from "./mediaLibrary";
import { ConfirmButton } from "./PackToolbar";

interface MediaLibraryPanelProps {
  records: MediaRecord[];
  usage: Map<string, number>;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  onImportFiles: (files: FileList) => void;
  onRemove: (name: string) => void;
  importError: string | null;
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
  const { records, usage, selectedName, onSelect, onImportFiles, onRemove, importError } = props;
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
      {records.length === 0 ? (
        <p className="editor-empty">
          No media yet. Import a file to create your first effect — nothing is
          uploaded anywhere; files stay in this session.
        </p>
      ) : filtered.length === 0 ? (
        <p className="editor-empty">No media matches this filter.</p>
      ) : (
        <ul className="editor-media-list">
          {filtered.map((record) => {
            const used = usage.get(record.name) ?? 0;
            const selected = selectedName === record.name;
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
                  </span>
                </button>
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
