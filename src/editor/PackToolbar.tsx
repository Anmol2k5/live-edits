import { useRef, useState } from "react";
import type { ReactionPack } from "../packs/packSchemas";

interface PackToolbarProps {
  packs: ReactionPack[];
  selectedPackId: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onSelectPack: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onActivate: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  isActive: boolean;
  importError: string | null;
}

/** Two-step destructive button: first click arms, second confirms. */
export function ConfirmButton({
  label,
  armLabel,
  onConfirm,
  title,
}: {
  label: string;
  armLabel: string;
  onConfirm: () => void;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} title={title}>
        {label}
      </button>
    );
  }
  return (
    <span className="editor-confirm">
      <button type="button" onClick={() => setArmed(false)}>
        Keep
      </button>
      <button
        type="button"
        className="editor-confirm__danger"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        autoFocus
      >
        {armLabel}
      </button>
    </span>
  );
}

export function PackToolbar(props: PackToolbarProps) {
  const {
    packs,
    selectedPackId,
    dirty,
    canUndo,
    canRedo,
    onSelectPack,
    onCreate,
    onRename,
    onDuplicate,
    onDelete,
    onExport,
    onImport,
    onActivate,
    onSave,
    onUndo,
    onRedo,
    isActive,
    importError,
  } = props;
  const [nameDraft, setNameDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Reaction packs">
      <label className="editor-toolbar__pack">
        Pack
        <select
          aria-label="Reaction pack"
          value={selectedPackId ?? ""}
          onChange={(e) => {
            if (e.target.value) onSelectPack(e.target.value);
          }}
        >
          <option value="" disabled>
            {packs.length === 0 ? "No packs yet" : "Choose a pack"}
          </option>
          {packs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.effects.length > 0 ? ` (${p.effects.length})` : ""}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label="New pack name"
        placeholder="New pack name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && nameDraft.trim()) {
            onCreate(nameDraft.trim());
            setNameDraft("");
          }
        }}
      />
      <button
        type="button"
        onClick={() => {
          if (nameDraft.trim()) {
            onCreate(nameDraft.trim());
            setNameDraft("");
          }
        }}
        disabled={!nameDraft.trim()}
      >
        Create
      </button>
      <button
        type="button"
        onClick={() => {
          if (nameDraft.trim()) {
            onRename(nameDraft.trim());
            setNameDraft("");
          }
        }}
        disabled={!selectedPackId || !nameDraft.trim()}
        title="Rename the selected pack to the typed name"
      >
        Rename
      </button>
      <button type="button" onClick={onDuplicate} disabled={!selectedPackId}>
        Duplicate
      </button>
      {selectedPackId && (
        <ConfirmButton
          label="Delete"
          armLabel="Confirm delete"
          onConfirm={onDelete}
          title="Delete the selected pack"
        />
      )}
      <button type="button" onClick={onExport} disabled={!selectedPackId}>
        Export
      </button>
      <button type="button" onClick={() => fileRef.current?.click()}>
        Import
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label="Import pack JSON"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onImport(file);
          e.target.value = "";
        }}
      />
      <button type="button" onClick={onActivate} disabled={!selectedPackId || isActive}>
        {isActive ? "Active ✓" : "Activate"}
      </button>
      <button
        type="button"
        className="editor-toolbar__save"
        onClick={onSave}
        disabled={!selectedPackId || !dirty}
      >
        Save{dirty ? " •" : ""}
      </button>
      <button type="button" onClick={onUndo} disabled={!canUndo} title="Undo (draft only)">
        Undo
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo} title="Redo (draft only)">
        Redo
      </button>
      <span
        className="editor-toolbar__dirty"
        role="status"
        aria-live="polite"
      >
        {selectedPackId ? (dirty ? "Unsaved changes" : isActive ? "Saved · active" : "Saved") : "Create a pack to begin"}
      </span>
      {importError && (
        <span className="editor-toolbar__error" role="alert">
          Import failed: {importError}
        </span>
      )}
    </div>
  );
}
