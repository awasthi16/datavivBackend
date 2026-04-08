# Real-Time Frame Streaming Engine

This repository is organized into two app folders:

- `backend/`: Node.js control plane, scheduler, preprocessing, storage, and API server
- `frontend/`: React dashboard powered by Vite

## Backend Architecture

- `src/scheduler/worker.js`: monotonic playback clock using `process.hrtime.bigint()`
- `src/protocol/commands.js`: binary schema encode/decode
- `src/control/stcpServer.js`: TCP control socket for binary commands
- `src/state/sessionStore.js`: Redis persistence
- `src/rtc/mediasoupManager.js`: Mediasoup worker/router bootstrap and producer swap hooks
- `src/media/*`: synthetic frame/audio sources for local validation
- `src/media/preprocessor.js`: FFmpeg/FFprobe-based source preprocessing
- `src/monitoring/metricsCollector.js`: dashboard metrics aggregation

## Binary Command Schema

Big-endian, fixed width, `18 bytes` total:

| Offset | Field | Type | Bytes |
|---|---|---|---:|
| 0 | `action` | `uint8` | 1 |
| 1 | `streamId` | `uint8` | 1 |
| 2 | `frameIndex` | `uint32` | 4 |
| 6 | `timestamp` | `float64` | 8 |
| 14 | `speed` | `float32` | 4 |

Actions:

- `1 = PLAY`
- `2 = PAUSE`
- `3 = SEEK`
- `4 = SWITCH_SOURCE`
- `5 = SET_SPEED`
- `6 = RESUME`
- `7 = SET_LOOP_MODE`
- `8 = SYNC`

## Running

1. Install backend dependencies:

```bash
cd backend
npm install
```

2. Install frontend dependencies:

```bash
cd ../frontend
npm install
```

3. Start Redis locally.

4. Copy `backend/.env.example` to `backend/.env` and adjust ports or Mediasoup IPs if needed.
If FFmpeg is not on your system `PATH`, also set `FFMPEG_PATH` and `FFPROBE_PATH` to the full executable paths.

5. Start the backend:

```bash
cd ../backend
npm start
```

6. Start the frontend development server:

```bash
cd ../frontend
npm run dev
```

7. Build the frontend for production serving from Express:

```bash
cd ../frontend
npm run build
```

8. Optional backend smoke test:

```bash
cd ../backend
npm run smoke
```

9. Optional preprocess from a local MP4/MOV file:

```bash
cd ../backend
npm run preprocess -- "C:\\videos\\sample.mp4" 101 "Sample Source"
```

## Deploying on Render

This backend can be deployed as a Render web service using the included [render.yaml](/c:/Users/HP/OneDrive/Desktop/dataviv/backend/render.yaml).

Recommended setup for the free tier:

- use `npm ci` for build
- use `npm start` for the web process
- keep `MEDIASOUP_ENABLED=false`
- provide `REDIS_URL` only if you have an external Redis instance

Important limitation:

- the free Render web service is fine for the HTTP API, dashboard, and SSE
- it is not a good fit for the full live WebRTC/UDP mediasoup path
- if you need actual streaming transport, you will likely need a host that allows the required UDP port range and long-lived media connections

## HTTP API

- `GET /health`
- `GET /schema`
- `GET /sources`
- `GET /sources/:sourceId/manifest`
- `GET /session/default`
- `GET /metrics`
- `GET /events`
- `POST /session/default/play`
- `POST /session/default/pause`
- `POST /session/default/resume`
- `POST /session/default/seek`
- `POST /session/default/speed`
- `POST /session/default/switch/2`
- `POST /session/default/loop-mode`
- `POST /session/default/sync`
- `POST /preprocess`

## STCP Control Plane

The TCP control server listens on `CONTROL_PORT` and expects one full 18-byte command packet per write.

Example sender:

```js
const net = require('node:net');
const { encodeCommand } = require('./src/protocol/commands');

const socket = net.createConnection({ port: 9000 }, () => {
  socket.write(
    encodeCommand({
      action: 1,
      streamId: 1,
      frameIndex: 0,
      timestamp: 0,
      speed: 1.0
    })
  );
});
```

## Mediasoup Instant Source Switching

This project keeps the transport graph stable and swaps media sources by replacing tracks on the existing producers:

```js
await videoProducer.replaceTrack({ track: nextVideoTrack });
await audioProducer.replaceTrack({ track: nextAudioTrack });
```

That avoids SDP renegotiation and preserves the downstream consumer pipeline. For a real broadcaster integration:

- create long-lived send transports
- keep one producer for audio and one for video
- prewarm the next source encoder
- call `replaceTrack()` on both producers
- request a keyframe on downstream consumers after the video swap

## Notes

- The repository includes synthetic sources so the scheduler and control path run immediately.
- Imported sources are normalized into extracted frames and an audio stem manifest under `storage/sources/<sourceId>/`.
- The dashboard is available at `http://localhost:8080/` after the frontend build is generated.
- Redis is used when available; if it is not running, the app falls back to `storage/session-store.json` so local startup still works.
- If the Mediasoup native worker cannot spawn in the current environment, the app stays up in mock transport mode and keeps the scheduler/control/dashboard layers active.
- A real upstream broadcaster still needs to attach actual `MediaStreamTrack` objects before `replaceTrack()` can swap live media.
- The scheduler emits integration callbacks matching the spec:

```js
integrationBus.onFrame((frame, timestamp) => {});
integrationBus.onAudio((audioChunk, timestamp) => {});
```
