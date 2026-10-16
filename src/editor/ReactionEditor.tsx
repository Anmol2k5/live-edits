import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPack,
  renamePack,
  duplicatePack,
  serializePack,
  importPack,
  type ReactionPack,
  type SequenceStep,
} from "../packs/packSchemas";
import { getActivePack } from "../packs/packStore";
import type { PackLibrary } from "../packs/packStore";
import {
  applyEffectPatch,
  createEffect,
  type NewEffectOptions,
} from "./effectEditing";
import {
  validateMediaFile,
  probeMediaMetadata,
  applyProbeResult,
  MediaRegistry,
} from "./mediaLibrary";
import {
  uploadMedia,
  deleteRelayMedia,
  fetchRelayInventory,
  MediaTransferError,
  type RelayMediaItem,
} from "../relay/mediaTransfer";
import { mediaKindForFile } from "../effects/effectSchemas";
import { useUndoable, isDirty } from "./useUndoable";
import { useSequencePlayback } from "./useSequencePlayback";
import type { AnyEffect, EffectKind } from "../effects/effectSchemas";
import type { MomentType } from "../templates/schemas";
import type { TriggerSource } from "../trigger/triggerSchemas";
import type { PlaybackInput } from "../effects/playback";
import { PackToolbar } from "./PackToolbar";
import { MediaLibraryPanel } from "./MediaLibraryPanel";
import { PreviewStage } from "./PreviewStage";
import { EffectPropertiesPanel } from "./EffectPropertiesPanel";
import { SequencePanel } from "./SequencePanel";

interface ReactionEditorProps {
  library: PackLibrary;
  onLibraryChange: (library: PackLibrary) => void;
  media: MediaRegistry;
  onMediaChange: () => void;
  relayReady: boolean;
  relayBase?: string;
  publishToken?: string;
  onFireEffect: (effect: AnyEffect, pack: ReactionPack) => void;
}

export type TransferStatus =
  | { state: "idle"; message?: string }
  | { state: "uploading"; message?: string }
  | { state: "on-relay"; message?: string }
  | { state: "conflict"; message: string }
  | { state: "error"; message: string };

let stepCounter = 0;
let assignmentCounter = 0;

const NO_STEPS: SequenceStep[] = [];
const NO_EFFECTS: AnyEffect[] = [];

function templateUrlFor(effect: AnyEffect): string {
  if (effect.kind === "frame") return `/templates/${effect.templateId}.png`;
  if (
    (effect.kind === "popup" || effect.kind === "audio") &&
    effect.templateId
  ) {
    return `/templates/${effect.templateId}.png`;
  }
  return `/templates/${effect.moment}-1.png`;
}

export function ReactionEditor(props: ReactionEditorProps) {
  const {
    library,
    onLibraryChange,
    media,
    onMediaChange,
    relayReady,
    relayBase = "http://127.0.0.1:4190",
    publishToken = "",
    onFireEffect,
  } = props;

  const [selectedPackId, setSelectedPackId] = useState<string | null>(
    library.activePackId ?? library.packs[0]?.id ?? null
  );
  const selectedPack = library.packs.find((p) => p.id === selectedPackId) ?? null;

  const draftCtl = useUndoable<ReactionPack | null>(selectedPack);
  const draft = draftCtl.state;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null);
  const [selectedMediaName, setSelectedMediaName] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<EffectKind>("video");

  // Relay media transfer (M6.1 A): inventory + per-file upload state.
  // File bytes are retained in-session for upload; after reload the relay
  // copy persists on disk so saved effects still fire without reimport.
  const [relayInventory, setRelayInventory] = useState<RelayMediaItem[] | null>(null);
  const [relayNote, setRelayNote] = useState<string | null>(null);
  const [transferStates, setTransferStates] = useState<Record<string, TransferStatus>>({});
  const fileBlobs = useRef(new Map<string, File>());
  const tokenTrimmed = publishToken.trim();

  const refreshInventory = useCallback(async () => {
    if (!tokenTrimmed) {
      setRelayInventory(null);
      return;
    }
    try {
      const items = await fetchRelayInventory(relayBase, tokenTrimmed);
      setRelayInventory(items);
      setRelayNote(null);
      setTransferStates((prev) => {
        const next = { ...prev };
        for (const item of items) {
          if (!next[item.name] || next[item.name]?.state === "idle") {
            next[item.name] = { state: "on-relay" };
          } else if (next[item.name]?.state === "uploading") {
            next[item.name] = { state: "on-relay" };
          }
        }
        return next;
      });
    } catch (err) {
      setRelayNote(err instanceof Error ? err.message : String(err));
    }
  }, [relayBase, tokenTrimmed]);

  useEffect(() => {
    if (!tokenTrimmed) {
      setRelayInventory(null);
      return;
    }
    void refreshInventory();
  }, [refreshInventory, tokenTrimmed]);

  // Single-effect preview shares the PreviewStage with sequence playback.
  const [previewInput, setPreviewInput] = useState<PlaybackInput | null>(null);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewStatus, setPreviewStatus] = useState("Idle — transparent, like OBS.");
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPreviewTimers = useCallback(() => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    if (progressTimer.current !== null) {
      clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  }, []);

  useEffect(() => stopPreviewTimers, [stopPreviewTimers]);

  const dirty = draft !== null && selectedPack !== null && isDirty(draft, selectedPack);
  const isActive = library.activePackId !== null && library.activePackId === selectedPackId;

  // --- pack switching -------------------------------------------------
  const switchPack = useCallback(
    (id: string) => {
      const target = library.packs.find((p) => p.id === id) ?? null;
      stopPreviewTimers();
      setPreviewInput(null);
      setPreviewProgress(0);
      setFieldErrors({});
      setSelectedEffectId(null);
      setPendingSwitchId(null);
      setSelectedPackId(id);
      draftCtl.reset(target);
    },
    [library.packs, stopPreviewTimers, draftCtl]
  );

  const requestSwitch = useCallback(
    (id: string) => {
      if (id === selectedPackId) return;
      if (dirty) {
        setPendingSwitchId(id);
        return;
      }
      switchPack(id);
    },
    [dirty, selectedPackId, switchPack]
  );

  // --- library operations (persist immediately) ------------------------
  const persist = useCallback(
    (packs: ReactionPack[], activePackId: string | null) => {
      onLibraryChange({ version: 1, packs, activePackId });
    },
    [onLibraryChange]
  );

  const handleCreate = useCallback(
    (name: string) => {
      try {
        const pack = createPack(name);
        const packs = [...library.packs, pack];
        persist(packs, library.activePackId);
        setSelectedPackId(pack.id);
        draftCtl.reset(pack);
        setSelectedEffectId(null);
        setFieldErrors({});
      } catch {
        // createPack only throws on empty names; the button is disabled then.
      }
    },
    [library, persist, draftCtl]
  );

  const handleDuplicate = useCallback(() => {
    if (!draft) return;
    const copy = duplicatePack(draft);
    const packs = [...library.packs, copy];
    persist(packs, library.activePackId);
    setSelectedPackId(copy.id);
    draftCtl.reset(copy);
    setSelectedEffectId(null);
  }, [draft, library, persist, draftCtl]);

  const handleDelete = useCallback(() => {
    if (!selectedPackId) return;
    const packs = library.packs.filter((p) => p.id !== selectedPackId);
    const activePackId =
      library.activePackId === selectedPackId ? null : library.activePackId;
    persist(packs, activePackId);
    const next = packs[0] ?? null;
    setSelectedPackId(next?.id ?? null);
    draftCtl.reset(next);
    setSelectedEffectId(null);
    setFieldErrors({});
  }, [selectedPackId, library, persist, draftCtl]);

  const handleExport = useCallback(() => {
    if (!draft) return;
    if (typeof URL.createObjectURL !== "function") {
      setImportError("Export needs a browser download API — unavailable here.");
      return;
    }
    const blob = new Blob([serializePack(draft)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${draft.name.replace(/[^a-z0-9-_]+/gi, "-")}.live-edits.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [draft]);

  const handleImportFile = useCallback(
    async (file: File) => {
      setImportError(null);
      try {
        const text = await file.text();
        const incoming: unknown = JSON.parse(text);
        const pack = importPack(incoming, {
          packIds: new Set(library.packs.map((p) => p.id)),
          effectIds: new Set(library.packs.flatMap((p) => p.effects.map((e) => e.id))),
        });
        const packs = [...library.packs, pack];
        persist(packs, library.activePackId);
        setSelectedPackId(pack.id);
        draftCtl.reset(pack);
        setSelectedEffectId(null);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : String(err));
      }
    },
    [library, persist, draftCtl]
  );

  const handleActivate = useCallback(() => {
    if (!selectedPackId) return;
    persist(library.packs, selectedPackId);
  }, [selectedPackId, library.packs, persist]);

  const handleSave = useCallback(() => {
    if (!draft || !selectedPackId) return;
    const packs = library.packs.map((p) => (p.id === selectedPackId ? draft : p));
    persist(packs, library.activePackId);
    draftCtl.reset(draft);
  }, [draft, selectedPackId, library, persist, draftCtl]);

  // --- draft edits (undoable, saved explicitly) ------------------------
  const updateDraft = useCallback(
    (fn: (pack: ReactionPack) => ReactionPack) => {
      draftCtl.set((prev) => (prev ? fn(prev) : prev));
    },
    [draftCtl]
  );

  const selectedEffect = draft?.effects.find((e) => e.id === selectedEffectId) ?? null;

  const handlePatchEffect = useCallback(
    (patch: Partial<Record<string, unknown>>) => {
      if (!draft || !selectedEffect) return;
      const result = applyEffectPatch(selectedEffect, patch);
      if (!result.ok) {
        setFieldErrors(result.errors);
        return;
      }
      setFieldErrors({});
      const next = result.effect;
      updateDraft((pack) => ({
        ...pack,
        effects: pack.effects.map((e) => (e.id === next.id ? next : e)),
      }));
    },
    [draft, selectedEffect, updateDraft]
  );

  const handleToggleEnabled = useCallback(() => {
    if (!selectedEffect) return;
    handlePatchEffect({ enabled: !selectedEffect.enabled });
  }, [selectedEffect, handlePatchEffect]);

  const handleCreateEffect = useCallback(
    (options: Omit<NewEffectOptions, "moment"> & { moment?: MomentType }) => {
      if (!draft) return;
      setCreateError(null);
      try {
        const effect = createEffect({
          ...options,
          moment: options.moment ?? selectedEffect?.moment ?? "wow",
        });
        updateDraft((pack) => ({ ...pack, effects: [...pack.effects, effect] }));
        setSelectedEffectId(effect.id);
        setFieldErrors({});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setCreateError(message);
        setFieldErrors({ _form: message });
      }
    },
    [draft, selectedEffect, updateDraft]
  );

  const handleDeleteEffect = useCallback(() => {
    if (!draft || !selectedEffectId) return;
    updateDraft((pack) => ({
      ...pack,
      effects: pack.effects.filter((e) => e.id !== selectedEffectId),
      assignments: pack.assignments.filter((a) => a.effectId !== selectedEffectId),
      sequence: pack.sequence.filter((s) => s.effectId !== selectedEffectId),
    }));
    setSelectedEffectId(null);
    setFieldErrors({});
  }, [draft, selectedEffectId, updateDraft]);

  const handleAddAssignment = useCallback(
    (source: TriggerSource, moment?: MomentType) => {
      if (!draft || !selectedEffectId) return;
      assignmentCounter += 1;
      const id = `assign-${Date.now()}-${assignmentCounter}`;
      updateDraft((pack) => ({
        ...pack,
        assignments: [
          ...pack.assignments,
          {
            id,
            source,
            ...(moment ? { moment } : {}),
            effectId: selectedEffectId,
          },
        ],
      }));
    },
    [draft, selectedEffectId, updateDraft]
  );

  const handleRemoveAssignment = useCallback(
    (id: string) => {
      updateDraft((pack) => ({
        ...pack,
        assignments: pack.assignments.filter((a) => a.id !== id),
      }));
    },
    [updateDraft]
  );

  // --- sequence edits --------------------------------------------------
  const handleAddStep = useCallback(
    (effectId: string) => {
      stepCounter += 1;
      const id = `step-${Date.now()}-${stepCounter}`;
      updateDraft((pack) => ({
        ...pack,
        sequence: [...pack.sequence, { id, effectId, delayMs: 0 }],
      }));
    },
    [updateDraft]
  );

  const handleRemoveStep = useCallback(
    (stepId: string) => {
      updateDraft((pack) => ({
        ...pack,
        sequence: pack.sequence.filter((s) => s.id !== stepId),
      }));
    },
    [updateDraft]
  );

  const handleMoveStep = useCallback(
    (stepId: string, direction: -1 | 1) => {
      updateDraft((pack) => {
        const index = pack.sequence.findIndex((s) => s.id === stepId);
        const other = index + direction;
        if (index < 0 || other < 0 || other >= pack.sequence.length) return pack;
        const sequence = [...pack.sequence];
        const [moved] = sequence.splice(index, 1);
        if (!moved) return pack;
        sequence.splice(other, 0, moved);
        return { ...pack, sequence };
      });
    },
    [updateDraft]
  );

  const handlePatchStep = useCallback(
    (stepId: string, delayMs: number) => {
      updateDraft((pack) => ({
        ...pack,
        sequence: pack.sequence.map((s) =>
          s.id === stepId ? { ...s, delayMs } : s
        ),
      }));
    },
    [updateDraft]
  );

  // --- media import + relay transfer -----------------------------------
  const handleUpload = useCallback(
    async (name: string) => {
      const file = fileBlobs.current.get(name);
      if (!file) {
        setTransferStates((prev) => ({
          ...prev,
          [name]: {
            state: "error",
            message: "File bytes are gone (reloaded) — reimport to upload.",
          },
        }));
        return;
      }
      if (!tokenTrimmed) {
        setTransferStates((prev) => ({
          ...prev,
          [name]: { state: "error", message: "Paste the relay publish token first." },
        }));
        return;
      }
      setTransferStates((prev) => ({ ...prev, [name]: { state: "uploading" } }));
      try {
        await uploadMedia(relayBase, tokenTrimmed, file, file);
        setTransferStates((prev) => ({ ...prev, [name]: { state: "on-relay" } }));
        await refreshInventory();
      } catch (err) {
        if (err instanceof MediaTransferError && (err.code === "exists" || err.status === 409)) {
          setTransferStates((prev) => ({
            ...prev,
            [name]: {
              state: "conflict",
              message: "Already on the relay — Replace deletes it first, then uploads.",
            },
          }));
          await refreshInventory();
          return;
        }
        setTransferStates((prev) => ({
          ...prev,
          [name]: { state: "error", message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [relayBase, tokenTrimmed, refreshInventory]
  );

  const handleReplaceRelay = useCallback(
    async (name: string) => {
      const file = fileBlobs.current.get(name);
      if (!file) {
        setTransferStates((prev) => ({
          ...prev,
          [name]: {
            state: "error",
            message: "File bytes are gone (reloaded) — reimport to replace.",
          },
        }));
        return;
      }
      if (!tokenTrimmed) {
        setTransferStates((prev) => ({
          ...prev,
          [name]: { state: "error", message: "Paste the relay publish token first." },
        }));
        return;
      }
      setTransferStates((prev) => ({ ...prev, [name]: { state: "uploading", message: "Replacing…" } }));
      try {
        await deleteRelayMedia(relayBase, tokenTrimmed, name).catch((err) => {
          if (err instanceof MediaTransferError && err.status === 404) return;
          throw err;
        });
        await uploadMedia(relayBase, tokenTrimmed, file, file);
        setTransferStates((prev) => ({ ...prev, [name]: { state: "on-relay" } }));
        await refreshInventory();
      } catch (err) {
        setTransferStates((prev) => ({
          ...prev,
          [name]: { state: "error", message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [relayBase, tokenTrimmed, refreshInventory]
  );

  const handleDeleteRelay = useCallback(
    async (name: string) => {
      if (!tokenTrimmed) {
        setRelayNote("Paste the relay publish token first.");
        return;
      }
      try {
        await deleteRelayMedia(relayBase, tokenTrimmed, name);
        setTransferStates((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        await refreshInventory();
      } catch (err) {
        setRelayNote(err instanceof Error ? err.message : String(err));
      }
    },
    [relayBase, tokenTrimmed, refreshInventory]
  );

  const handleImportFiles = useCallback(
    async (files: FileList) => {
      setMediaError(null);
      let firstError: string | null = null;
      const imported: File[] = [];
      for (const file of Array.from(files)) {
        const validation = validateMediaFile({
          name: file.name,
          size: file.size,
          type: file.type,
        });
        if (!validation.ok) {
          firstError = firstError ?? `${file.name}: ${validation.reason}`;
          continue;
        }
        const kind = mediaKindForFile(file.name);
        if (!kind) {
          firstError = firstError ?? `${file.name}: unsupported type.`;
          continue;
        }
        const url = URL.createObjectURL(file);
        // List immediately; metadata fills in when the probe resolves so
        // slow decoders never block the import flow.
        media.add({
          name: file.name,
          kind,
          bytes: file.size,
          mime: file.type || kind,
          url,
          width: null,
          height: null,
          durationMs: null,
          available: true,
        });
        // Retain bytes for the relay upload (streamed, never re-buffered).
        fileBlobs.current.set(file.name, file);
        imported.push(file);
        onMediaChange();
        setSelectedMediaName(file.name);
        void probeMediaMetadata(url, kind).then((meta) => {
          if (applyProbeResult(media, file.name, url, meta)) onMediaChange();
        });
      }
      if (firstError) setMediaError(firstError);
      // Automatic transfer: when the relay token is present, stream each
      // import straight to the relay so no manual copy is ever needed.
      // Without a token the files stay local and the panel offers retry.
      if (tokenTrimmed) {
        for (const file of imported) {
          setTransferStates((prev) =>
            prev[file.name]?.state === "on-relay" ? prev : { ...prev, [file.name]: { state: "uploading" } }
          );
        }
        for (const file of imported) {
          try {
            await uploadMedia(relayBase, tokenTrimmed, file, file);
            setTransferStates((prev) => ({ ...prev, [file.name]: { state: "on-relay" } }));
          } catch (err) {
            if (err instanceof MediaTransferError && (err.code === "exists" || err.status === 409)) {
              setTransferStates((prev) => ({
                ...prev,
                [file.name]: {
                  state: "conflict",
                  message: "Already on the relay — Replace deletes it first, then uploads.",
                },
              }));
              continue;
            }
            setTransferStates((prev) => ({
              ...prev,
              [file.name]: {
                state: "error",
                message: err instanceof Error ? err.message : String(err),
              },
            }));
          }
        }
        await refreshInventory();
      }
    },
    [media, onMediaChange, relayBase, tokenTrimmed, refreshInventory]
  );

  const handleRemoveMedia = useCallback(
    (name: string) => {
      media.remove(name);
      fileBlobs.current.delete(name);
      setTransferStates((prev) => {
        const next = { ...prev };
        // Local removal drops the local status; relay copies are removed
        // explicitly via Delete-from-relay so reload persistence is clear.
        delete next[name];
        return next;
      });
      if (selectedMediaName === name) setSelectedMediaName(null);
      onMediaChange();
    },
    [media, selectedMediaName, onMediaChange]
  );

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const effect of draft?.effects ?? []) {
      if (effect.kind === "frame") continue;
      const file = (effect as { mediaFile?: string }).mediaFile;
      if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    return counts;
  }, [draft]);

  const effectsById = useMemo(
    () => new Map((draft?.effects ?? []).map((e) => [e.id, e])),
    [draft]
  );

  // --- preview + sequence playback ------------------------------------
  const showPreview = useCallback(
    (effect: AnyEffect, durationOverrideMs?: number) => {
      stopPreviewTimers();
      const mediaFile =
        effect.kind === "frame"
          ? null
          : ((effect as { mediaFile?: string }).mediaFile ?? null);
      const record = mediaFile ? media.get(mediaFile) : undefined;
      if (mediaFile && (!record || !record.available)) {
        const onRelay = relayInventory?.some((m) => m.name === mediaFile) ?? false;
        setPreviewInput(null);
        setPreviewProgress(0);
        setPreviewStatus(
          onRelay
            ? `“${mediaFile}” is on the relay — Fire to OBS still plays it. Reimport to preview locally.`
            : `“${mediaFile}” is not imported in this session — reimport it to preview.`
        );
        return;
      }
      const input: PlaybackInput = {
        effect,
        mediaUrl: record?.url ?? "",
        templateUrl: templateUrlFor(effect),
      };
      setPreviewInput(input);
      setPreviewProgress(0);
      const visibleMs = durationOverrideMs ?? effect.durationMs;
      setPreviewStatus(`Previewing “${effect.name}” (${(visibleMs / 1000).toFixed(1)}s).`);
      const startedAt = Date.now();
      progressTimer.current = setInterval(() => {
        setPreviewProgress(
          Math.min(1, (Date.now() - startedAt) / Math.max(1, visibleMs))
        );
      }, 100);
      previewTimer.current = setTimeout(() => {
        stopPreviewTimers();
        setPreviewInput(null);
        setPreviewProgress(1);
        setPreviewStatus("Idle — transparent, like OBS.");
      }, visibleMs);
    },
    [media, stopPreviewTimers, relayInventory]
  );

  const sequence = useSequencePlayback(draft?.sequence ?? NO_STEPS, draft?.effects ?? NO_EFFECTS, {
    onCueStart: (cue) => {
      const effect = effectsById.get(cue.effectId);
      if (effect) showPreview(effect);
    },
    onCueEnd: () => {
      // The next cue (or finish) replaces the stage; gaps restore idle.
      setPreviewInput(null);
      setPreviewProgress(1);
    },
    onFinish: () => {
      setPreviewInput(null);
      setPreviewProgress(1);
      setPreviewStatus("Sequence finished — transparent, like OBS.");
    },
    onSkipped: (cue) => {
      setPreviewStatus(
        `Skipped “${effectsById.get(cue.effectId)?.name ?? cue.effectId}” (scheduler decision) — continuing.`
      );
    },
  });

  const handlePreviewEffect = useCallback(() => {
    if (selectedEffect) showPreview(selectedEffect);
  }, [selectedEffect, showPreview]);

  const handleFireEffect = useCallback(() => {
    if (draft && selectedEffect) onFireEffect(selectedEffect, draft);
  }, [draft, selectedEffect, onFireEffect]);

  const activePack = getActivePack(library);

  return (
    <div className="editor">
      <PackToolbar
        packs={library.packs}
        selectedPackId={selectedPackId}
        dirty={dirty}
        canUndo={draftCtl.canUndo}
        canRedo={draftCtl.canRedo}
        onSelectPack={requestSwitch}
        onCreate={handleCreate}
        onRename={(name) => {
          if (draft) {
            try {
              draftCtl.set(renamePack(draft, name));
            } catch {
              // Empty names are already disabled at the button.
            }
          }
        }}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onExport={handleExport}
        onImport={(file) => void handleImportFile(file)}
        onActivate={handleActivate}
        onSave={handleSave}
        onUndo={draftCtl.undo}
        onRedo={draftCtl.redo}
        isActive={isActive}
        importError={importError}
      />
      {pendingSwitchId && (
        <div className="editor-switch-banner" role="alert">
          <span>Unsaved changes in “{selectedPack?.name}”. Save first?</span>
          <button type="button" onClick={handleSave}>
            Save & switch
          </button>
          <button
            type="button"
            onClick={() => {
              handleSave();
              switchPack(pendingSwitchId);
            }}
          >
            Switch without saving
          </button>
          <button type="button" onClick={() => setPendingSwitchId(null)}>
            Cancel
          </button>
        </div>
      )}
      {draft === null ? (
        <p className="editor-empty editor-empty--page">
          No reaction pack yet. Create one above, then import media, build
          effects, and fire them to OBS — no webcam required.
        </p>
      ) : (
        <div className="editor-grid">
          <div className="editor-col editor-col--left">
            <MediaLibraryPanel
              records={media.list()}
              usage={usage}
              selectedName={selectedMediaName}
              onSelect={setSelectedMediaName}
              onImportFiles={(files) => void handleImportFiles(files)}
              onRemove={handleRemoveMedia}
              importError={mediaError}
              relayInventory={relayInventory}
              transferStates={transferStates}
              relayNote={relayNote}
              canUpload={tokenTrimmed.length > 0}
              onUpload={(name) => void handleUpload(name)}
              onReplaceRelay={(name) => void handleReplaceRelay(name)}
              onDeleteRelay={(name) => void handleDeleteRelay(name)}
              onRefreshRelay={() => void refreshInventory()}
            />
            <section className="editor-panel" aria-label="Pack effects">
              <h2>Effects ({draft.effects.length})</h2>
              {draft.effects.length === 0 ? (
                <p className="editor-empty">
                  No effects yet. Import media, then create your first effect
                  below.
                </p>
              ) : (
                <ul className="editor-effect-list">
                  {draft.effects.map((effect) => (
                    <li key={effect.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedEffectId(effect.id);
                          setFieldErrors({});
                        }}
                        aria-pressed={selectedEffectId === effect.id}
                      >
                        {effect.enabled ? "" : "⏸ "}
                        {effect.name} ({effect.kind})
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="editor-row">
                <select
                  aria-label="New effect kind"
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as EffectKind)}
                >
                  <option value="video">video</option>
                  <option value="image">image</option>
                  <option value="audio">audio</option>
                  <option value="cutaway">cutaway</option>
                  <option value="popup">popup</option>
                  <option value="frame">frame</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    handleCreateEffect({
                      kind: newKind,
                      ...(selectedMediaName ? { mediaFile: selectedMediaName } : {}),
                      ...(newKind === "frame" ? { templateId: "wow-1" } : {}),
                    })
                  }
                >
                  Create effect
                </button>
                {selectedEffectId && (
                  <ConfirmButtonInline label="Delete effect" onConfirm={handleDeleteEffect} />
                )}
              </div>
              {createError && (
                <p className="editor-error" role="alert">
                  {createError}
                </p>
              )}
              {activePack && (
                <p className="editor-hint">
                  Active pack: “{activePack.name}”. Moment triggers from the
                  camera and manual buttons resolve through it first.
                </p>
              )}
            </section>
          </div>
          <div className="editor-col editor-col--center">
            <PreviewStage
              input={previewInput}
              progress={previewProgress}
              statusText={previewStatus}
            />
            <SequencePanel
              steps={draft.sequence}
              cues={sequence.cues}
              effectsById={effectsById}
              totalMs={sequence.totalMs}
              elapsedMs={sequence.elapsedMs}
              status={sequence.status}
              currentStepId={sequence.current?.stepId ?? null}
              skippedStepIds={sequence.skippedStepIds}
              onAddStep={handleAddStep}
              onRemoveStep={handleRemoveStep}
              onMoveStep={handleMoveStep}
              onPatchStep={handlePatchStep}
              onPlay={sequence.play}
              onPause={sequence.pause}
              onSeek={sequence.seek}
              onReset={sequence.reset}
            />
          </div>
          <div className="editor-col editor-col--right">
            <EffectPropertiesPanel
              effect={selectedEffect}
              mediaNames={media.list().map((r) => r.name)}
              errors={fieldErrors}
              assignments={(draft.assignments ?? []).filter(
                (a) => a.effectId === selectedEffectId
              )}
              onPatch={handlePatchEffect}
              onToggleEnabled={handleToggleEnabled}
              onAddAssignment={handleAddAssignment}
              onRemoveAssignment={handleRemoveAssignment}
              onPreview={handlePreviewEffect}
              onFire={handleFireEffect}
              canFire={relayReady}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmButtonInline({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)}>
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
        autoFocus
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        Confirm
      </button>
    </span>
  );
}
