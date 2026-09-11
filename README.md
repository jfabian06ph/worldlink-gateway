# worldlink-gateway

A standalone peer-to-peer protocol for connecting AI agent worlds. Lets separate Claude instances collaborate: delegate tasks, share context, retrieve artifacts — without central infrastructure.

Zero external dependencies. Pure Node.js ≥ 18.

---

## Quick start

```bash
# Install globally
npm install -g worldlink-gateway

# Or run without installing
npx worldlink-gateway init
npx worldlink-gateway start
```

---

## Setup

```bash
# 1. Initialize this world (generates Ed25519 keypair, writes config)
worldlink-gateway init

# 2. Start the gateway
worldlink-gateway start          # default port 7461
worldlink-gateway start 8080     # custom port

# 3. Open the status page
open http://localhost:7461/
```

The init wizard asks for:
- **World name** — displayed to peers (e.g. "Joseph-iOS")
- **Capabilities** — what this world can do (e.g. `claude-task`, `code-review`)
- **Auto-approve** — approve all incoming tasks automatically (for testing)

---

## Connecting worlds

```bash
# On World A — connect to World B
worldlink-gateway connect http://worldb.local:7461

# Check connected peers
worldlink-gateway status

# Send a task to World B
worldlink-gateway request <worldBId> claude-task "Explain this TypeScript error: ..."
```

Tasks are executed by `claude -p` on the receiving world. The result is stored as an artifact and can be retrieved by the requesting world.

---

## Security model

- **Ed25519 keypairs** — every world has a unique identity
- **3-phase handshake** — Discovery → Connect (signed) → Confirm (challenge-response)
- **HMAC session tokens** — 1hr expiry, per-connection
- **Approval by default** — incoming tasks require explicit approval unless `requiresApproval: false`
- **Audit log** — every connection and task recorded to `.worldlink-audit.jsonl`
- **No filesystem access** — remote worlds cannot read or write local files
- **Artifacts TTL** — results expire after 1 hour

---

## Fake Karlo test (two local worlds)

```bash
# Terminal 1 — "Joseph" world
mkdir ~/wl-joseph && cd ~/wl-joseph
worldlink-gateway init        # name: Joseph-iOS
worldlink-gateway start 7461

# Terminal 2 — "Karlo" world (auto-approve for testing)
mkdir ~/wl-karlo && cd ~/wl-karlo
worldlink-gateway init        # name: Karlo-Android
worldlink-gateway start 7462 --auto-approve

# Terminal 3 — connect and send a task
cd ~/wl-joseph
worldlink-gateway connect http://localhost:7462
worldlink-gateway request wld_<karloId> claude-task "List 3 benefits of TypeScript"

# Approve pending tasks (if not auto-approve)
worldlink-gateway approve <taskId>
```

Status pages:
- Joseph → http://localhost:7461/
- Karlo  → http://localhost:7462/

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
| `GET` | `/worldlink/peers` | List connected peers |
| `GET` | `/worldlink/tasks` | List recent tasks (status page) |
| `GET` | `/worldlink/audit` | Last 100 audit events |
| `POST` | `/worldlink/connect-peer` | Initiate outbound connection |
| `POST` | `/worldlink/request` | Send task to a connected peer |
| `POST` | `/worldlink/poll-artifact` | Fetch artifact from peer |

---

## Config files

| File | Description |
|------|-------------|
| `.worldlink-identity.json` | **Secret** — Ed25519 keypair + world ID. Mode 600. |
| `.worldlink-config.json` | World name, capabilities, trusted peers |
| `.worldlink-audit.jsonl` | Append-only audit log |

All three are gitignored by default.

---

## Use cases

1. **Screenshot / error sharing** — paste a screenshot into World A; WorldLink sends it to World B's Claude for analysis
2. **Cross-platform ticket pickup** — iOS dev sends TypeScript ticket context to web dev's world with shared repo branch
3. **Pod disbanding** — knowledge preservation handoff before a team disbands
4. **UI/QA broadcast** — fan out a review request to multiple worlds simultaneously

---

## License

MIT
