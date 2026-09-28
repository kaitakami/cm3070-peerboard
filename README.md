# PeerBoard

A browser whiteboard with freehand drawing, sticky notes and peer-to-peer synchronisation. Board content is stored in each browser's IndexedDB. A WebSocket signalling service introduces peers, and Yjs updates travel over WebRTC data channels.

## Run locally

Use Node.js 22.12 or newer. This revision was tested with Node.js 25.3.0.

```sh
npm ci
npm run signal
```

In a second terminal:

```sh
npm run dev
```

Open http://127.0.0.1:5174. Copy the complete address, including the room fragment, into another browser or a private window. Wait for the peer indicator to show a connection before demonstrating collaboration.

Use **Sticky note** and click the board to add or edit a note. **Erase** removes the clicked element. **Work offline** disconnects collaboration while keeping local editing available. **Reconnect** merges the document with connected peers. Open **Board details & notes** to compare visible-state fingerprints and edit notes with the keyboard.

Export important boards as JSON. Browser storage is useful but can be cleared or evicted. Import adds missing element IDs without replacing existing IDs.

## Test and build

```sh
npx playwright install chromium
npm test
npm run build
```

Tests start their own local Vite and signalling servers on ports 5174 and 4444, so stop manually started instances before running the suite. Tests use isolated Chromium contexts to prevent shared browser storage and BroadcastChannel from passing off as inter-device networking. Four-peer tests require three connected WebRTC peers on each client.

The test run writes `evidence/test-results.json`, `evidence/latency.json` and `evidence/four-peer-board.png`. Failures produce screenshots and traces in `test-results/`.

## Remote hosting

Serve `dist/` over HTTPS. Set `VITE_SIGNALING_URL` to your reachable WSS signalling endpoint before building. The default endpoint is the page hostname on port 4444 and is intended for local development. A static site alone does not provide signalling.

The repository uses the upstream `y-webrtc-signaling` executable for a local demonstration. A public deployment needs TLS, traffic limits and service management. There is no TURN relay configuration, and direct connections can fail behind restrictive NAT or firewalls. Opening a localhost link on a different computer will not reach the original computer.

## Behaviour and limits

- UUID room links act as shared access secrets. Anyone with the link can edit; there are no accounts or roles.
- Strokes are sent when the pointer is released, not continuously during drawing.
- Concurrent additions survive merging. Concurrent edits to the same sticky note resolve to one complete note value. This is not character-level collaborative text editing.
- Clearing removes elements known to the clearing peer. Concurrent new additions can survive.
- The interface uses a fixed 1600 by 1000 coordinate space, scaled to the viewport.
- The evaluation covers up to four peers on one machine. It does not establish Internet-wide reliability or larger-room scalability.
- The loaded app supports disconnected editing. There is no service worker, so a completely offline first load is not supported.
- Rendering ignores values that fail the board schema. This does not make the CRDT document safe against resource exhaustion by a malicious room participant.
- Notes show a five-line preview on the board; the full text is available in the note editor and notes list.

## Source structure

`src/model.ts` defines the element schemas, canonical ordering, hit testing and stroke simplification. `src/main.ts` connects the document, persistence, networking and UI. `tests/board.spec.mjs` exercises the application through browser interactions and checks exported state.

Yjs supplies the CRDT algorithm. y-webrtc supplies the transport and signalling protocol. y-indexeddb supplies persistence. The project contribution is the application, data model, interactions, validation, visual presentation and evaluation.
