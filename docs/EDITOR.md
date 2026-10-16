# Reaction packs & effect editor (M6)

The **Editor** tab (header, next to Live) is a creator-focused workspace for
building reaction packs without touching source code. It works with no
webcam: everything previews locally and fires to OBS through the relay.

## Workflow

1. **Create a pack** (toolbar): name it, or duplicate/import an existing one.
2. **Import media** (left): PNG/JPEG/WebP/GIF, MP4/WebM, MP3/WAV/OGG, 50 MB max,
   plain filenames. With the relay publish token set, imports stream straight
   to the relay automatically (authenticated, content-validated, atomic); without
   a token they stay local until you press Send to relay. Duplicates are refused
   with a confirmed Replace path; relay copies persist on disk across reloads.
3. **Create an effect** (left): pick a kind (video/image/audio/cutaway/popup/
   frame). Audio/video need the selected media file.
4. **Configure** (right): name, moment, media, position, duration, trim,
   volume, priority, cooldown, queue policy, entrance/exit, enabled, and
   trigger assignments (source + optional moment).
5. **Preview** (center): transparent 16:9 stage renders the same playback
   mapping OBS uses, with progress and idle restore.
6. **Sequence** (bottom): chain effects with per-step delays; play/pause/seek
   (slider)/reset. Every cue is admitted through the shared scheduler core,
   so cooldowns and queue policies behave exactly like OBS.
7. **Fire to OBS** (properties): publishes the configured effect to the relay
   (needs the publish token). **Preview** stays local; **Fire** goes to OBS.
8. **Save** (toolbar): persists the draft to localStorage. **Activate** makes
   the pack resolve live camera/manual triggers first.
9. **Export/Import**: validated `.live-edits.json` files; id collisions are
   rewritten automatically.

## Trigger resolution order

- Moment from camera/manual: pack assignments matching (source, moment) win,
  then source wildcards (assignments with no moment), otherwise the built-in
  template pick (unchanged V1 behavior).
- Effect triggers (editor Fire, sequence-free): resolve pack-first, static
  registry second; unknown ids are rejected, never published blindly.
- Only `frame` effects composite a local PNG. Media effects skip local
  composition and publish to OBS — the pipeline reports this explicitly
  (`MediaEffectError`) instead of failing silently.

## Undo, dirty state, destructive actions

- Pack-content edits (effects, assignments, sequence, rename) are undoable
  (50 steps) and redoable; the toolbar shows **Unsaved changes** until Save.
- Delete pack / delete effect / remove used media are two-step confirms
  ("Remove" → "Confirm"/"Remove (used by N)"). Switching packs with a dirty
  draft offers Save & switch / Switch without saving / Cancel.
- Switching, saving and activating never touch the webcam flows.

## Storage: what lives where (and why)

| Data | Location | Notes |
|---|---|---|
| Pack JSON (effects, assignments, sequence) | `localStorage` (`live-edits.packs.v1`, active id separately) | Validated with versioned Zod schemas; corrupt data starts clean without destroying the raw value |
| Media preview blobs + object URLs | In-memory `MediaRegistry` only | Never written to storage (5 MB quota safety); after reload, previews show reimport guidance but relay copies still fire |
| Relay media files | Relay media directory on disk (user-writable, loopback uploads only) | Authenticated streaming uploads, 50 MB cap, content sniffing, atomic rename, 409 on duplicates, inventory + delete APIs; survives reloads so saved effects play with no reimport |
| Export files | User-chosen download location | Validated on import; effect-id collisions rewritten, duplicate pack ids refreshed |

### Application-data directory investigation

Tauri exposes per-platform app-data paths (`appDataDir()` → `%APPDATA%\<id>` on
Windows, `~/Library/Application Support/<id>` on macOS, `~/.local/share/<id>`
on Linux) plus a scoped `fs` plugin for controlled file access. That is the
right long-term home for user media + pack JSON (survives reloads, no quota,
OS-managed cleanup on uninstall).

It is deliberately **not wired yet**: persisting outside the webview needs
Rust `fs` scope configuration and `cargo`-verified capability changes, which
this environment cannot verify (no Rust toolchain). The current layer is
shaped for the migration — filenames are already validated, traversal-safe,
size-capped, and referenced (never embedded) — so moving the backing store
later changes no schemas. Until then: session media + JSON export is the
durable path; the editor says so wherever it matters.

## Media rules (mirrored by the relay)

- Filename allowlist `^[A-Za-z0-9][A-Za-z0-9._-]*$`, 128 chars max, allowlisted
  extensions; traversal rejected in UI and at the relay boundary.
- 50 MB cap matches `MAX_FILE_BYTES`; oversize imports fail with the reason.
- Imports stream to the relay when the publish token is set (no manual copy);
  duplicates get 409 with a confirmed Replace (delete-then-upload) path.
- The relay re-validates everything and 400s unknown files — publishing a
  pack whose media was never sent to the relay fails
  loudly; relay inventory flags it beforehand.

## Keyboard & layout

- Every action is a native button/input/select: Tab reaches everything,
  Enter/Space activate, arrows move range sliders (volume, seek).
- Live regions announce save state, preview status, sequence position, and
  validation errors (`role="alert"`/`status`).
- Three-column grid collapses to one column under 1100 px; panels scroll
  independently.

## Honest limits

- Preview renders with the same mapping as OBS but is not OBS: autoplay
  policy, color management and performance are browser-tab realities.
  Audible output is only ever claimed after the manual check in
  `docs/OBS_SETUP.md`.
- Sequence timing uses the tab clock (`setTimeout`/`Date.now`); background
  tabs throttle — keep the window visible during sequence previews.
- Pack JSON never contains media bytes; sharing a pack means sharing the
  media files + the JSON side by side.
