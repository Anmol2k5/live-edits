# Streamer Moment Overlay — Tuning Notes

## Detection Thresholds (V1)

| Moment | Expression | Threshold | Extra Condition | Rationale |
|---|---|---|---|---|
| `wow` | `surprised` | 0.70 | — | Clean single signal, low false-positive rate at 0.7 |
| `funny` | `happy` | 0.80 | Δ ≥ 0.3 over ~1.2s window | Resting smile sits around 0.4-0.6. The delta requirement ensures only a *change* to laughter fires, not baseline expression. |
| `sad` | `sad` | 0.85 | — | Highest threshold. Sad detection has more false positives against neutral/thoughtful faces. 0.85 reduces noise. |

## Debounce

Two consecutive samples (at 400ms interval = ~800ms of sustained expression) required before trigger. Prevents single-frame noise from mis-classified expressions.

## Cooldown

Default: 4000ms. Prevents the same expression burst from firing multiple overlays. After each trigger, detector enters cooldown and ignores all scores until the timer elapses.

## Rate-of-Change Window (funny)

The `funnyDelta` check uses a sliding window of the last 4 `happy` scores (~1.6s). It requires that `newest - oldest ≥ 0.3`, meaning the person's happiness must have *increased* recently, not just stayed high. This prevents a relaxed smile from firing.

## Test Gestures

| Moment | Gesture |
|---|---|
| `wow` | Raise eyebrows + open mouth wide for ~1 second |
| `funny` | Start neutral, then break into a broad laugh/grin |
| `sad` | Frown, lower corners of mouth, optionally squint eyes |

## Polling Interval

400ms chosen as a balance between responsiveness and CPU usage. face-api.js TinyFaceDetector + expression net runs in ~150-200ms on a modern CPU, leaving headroom for the UI thread.

## Known Limitations

- face-api.js expression classification is trained on frontal faces — side profiles will not detect
- Low-light conditions reduce detection accuracy significantly
- Glasses/masks can reduce face detection confidence
- The `surprised` expression can false-positive on yawning
