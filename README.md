# worldlink-gateway

**The network layer for sovereign AI worlds.**

Run one WorldLink Gateway per AI agent. Each instance gets its own Ed25519 cryptographic identity, a persistent brain memory store, and a live presence in a peer-to-peer mesh. Connect across a local network in seconds — then delegate tasks between agents, share memories, retrieve artifacts, and watch your entire agent network render as floating islands in a real-time 3D visualization.

No accounts. No cloud. No central broker. A single Node.js process your AI can call home.

> Built on Ed25519 keypairs, HMAC-signed sessions, and an 8-second heartbeat protocol that keeps every world's presence accurate in real time. Zero npm dependencies. Pure Node.js ≥ 18.

---

![WorldLink Gateway — 3D world visualization showing two connected AI worlds](docs/worldlink-preview.png)

*Karlo's world (foreground) and Joseph's world (background), connected live over a local network. Right-click your island to switch between 7 environmental themes.*

---

## Quick start

```bash
# Clone the repository
git clone https://github.com/jfabian06ph/worldlink-gateway.git
cd worldlink-gateway
npm install

# Create a data directory for this world and initialize it
mkdir ~/my-world && cd ~/my-world
node /path/to/worldlink-gateway/bin/worldlink.js init

# Start the gateway (always run from your data directory)
node /path/to/worldlink-gateway/bin/worldlink.js start 7461
```

> **Important:** The gateway uses your current working directory as its data directory.
> Always `cd` into your world's data directory before starting — running from the wrong
> directory will use the wrong identity.

---

## Setup

```bash
# 1. Create and enter a data directory for this world
mkdir ~/my-world && cd ~/my-world

# 2. Initialize the world (generates Ed25519 keypair, writes config)
node /path/to/worldlink-gateway/bin/worldlink.js init

# 3. Start the gateway
node /path/to/worldlink-gateway/bin/worldlink.js start          # default port 7461
node /path/to/worldlink-gateway/bin/worldlink.js start 8080     # custom port

# 4. Open the status page (3D world visualization)
open http://localhost:7461/
```

The init wizard asks three questions:

```
World name [My World]:
Capabilities (comma-separated) [claude-task]:
Auto-approve tasks for testing? (y/N):
```

- **World name** — displayed to peers (e.g. `Joseph-iOS`, `Karlo-Lab`)
- **Capabilities** — comma-separated list of task types this world can handle. Defaults to `claude-task`. Common values: `claude-task`, `message`, `context-handoff`, `artifact.receive`
- **Auto-approve** — skip the manual approval step for incoming tasks (useful for local testing)

---

## Connecting worlds

From the status page, paste a peer's gateway URL into the **Connect to a World** field and click Connect. The gateway performs a bidirectional handshake and both worlds will appear in each other's 3D view.

You can also connect via the API:

```bash
# POST to connect-peer on your running gateway
curl -X POST http://localhost:7461/worldlink/connect-peer \
  -H "Content-Type: application/json" \
  -d '{"host": "http://peer.local:7461"}'
```

---

## Two-world local test

```bash
# Terminal 1 — "Joseph" world
mkdir ~/wl-joseph && cd ~/wl-joseph
node /path/to/worldlink-gateway/bin/worldlink.js init   # name: Joseph
node /path/to/worldlink-gateway/bin/worldlink.js start 7461

# Terminal 2 — "Karlo" world
mkdir ~/wl-karlo && cd ~/wl-karlo
node /path/to/worldlink-gateway/bin/worldlink.js init   # name: Karlo, auto-approve: yes
node /path/to/worldlink-gateway/bin/worldlink.js start 7462
```

Open both status pages:
- Joseph → http://localhost:7461/
- Karlo  → http://localhost:7462/

Use the Connect UI on either page to link them. Both worlds appear in each other's 3D view.

---

## Features

**3D world visualization** — A Three.js status page shows all connected worlds as floating islands. Switch between seven environmental themes (Default, Deep Space, Desert Planet, Ice Age, Sakura, Neon City, Prehistoric) by right-clicking your own island.

**Offline mode** — Mark your world as offline for a set duration from the Settings tab. Peers see your island as offline and the status propagates within seconds via the 8-second heartbeat.

**Brain / memory store** — Each world maintains a local `.worldlink-brain.jsonl` record store. Records can be shared with specific peers or the whole pod for context-handoff tasks.

**Task delegation** — Connected worlds can submit `claude-task` requests. Tasks are executed by Claude on the receiving world, and results are returned as artifacts.

---

## Security model

- **Ed25519 keypairs** — every world has a unique identity
- **3-phase handshake** — Discovery → Connect (signed) → Confirm (challenge-response)
- **Session tokens** — 24-hour expiry, per-connection
- **Approval gates** — incoming tasks require explicit approval unless `requiresApproval: false`
- **Audit log** — every connection and task recorded to `.worldlink-audit.jsonl`
- **No filesystem access** — remote worlds cannot read or write local files
- **Artifacts TTL** — results expire after 1 hour

---

## HTTP API

All routes are under `/worldlink/`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/worldlink/manifest` | World identity + capabilities |
| `POST` | `/worldlink/connect` | Initiate handshake |
| `POST` | `/worldlink/confirm` | Complete handshake (challenge-response) |
| `POST` | `/worldlink/task` | Submit a task (requires session token) |
| `GET` | `/worldlink/task/:id` | Poll task status |
| `GET` | `/worldlink/artifact/:id` | Retrieve artifact |
| `POST` | `/worldlink/approve/:id` | Approve a pending task |
| `POST` | `/worldlink/deny/:id` | Deny a pending task |
| `GET` | `/worldlink/peers` | List connected peers + local offline status |
| `GET` | `/worldlink/tasks` | List recent tasks |
| `GET` | `/worldlink/audit` | Last 100 audit events |
| `POST` | `/worldlink/connect-peer` | Initiate outbound connection |
| `GET` | `/worldlink/local/status` | Read this world's online/offline state |
| `POST` | `/worldlink/local/set-status` | Set this world offline for a duration |
| `GET` | `/worldlink/local/brain` | List brain records |
| `POST` | `/worldlink/local/brain` | Add a brain record |

---

## Config files

| File | Description |
|------|-------------|
| `.worldlink-identity.json` | **Secret** — Ed25519 keypair + world ID. Keep this safe. |
| `.worldlink-config.json` | World name, capabilities, trusted peers, AI backend |
| `.worldlink-audit.jsonl` | Append-only audit log of all connections and tasks |
| `.worldlink-brain.jsonl` | Local brain/memory records (shareable with peers) |

All four are gitignored by default.

---

## Use cases

1. **Cross-agent task delegation** — one Claude instance delegates a task to another and retrieves the artifact result
2. **Context handoff** — share brain records and session context before a pod disbands or a session ends
3. **Multi-world review** — fan out a review request to multiple connected worlds simultaneously
4. **Offline presence** — mark yourself unavailable without disconnecting; peers see your status update within seconds

---

## License

MIT
