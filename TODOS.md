# GSV TODO List

## Overview

GSV (Gateway-Session-Vector) is a distributed AI agent platform built on Cloudflare Durable Objects. This document tracks features to implement, prioritized based on clawdbot feature parity and user needs.

---

## Completed Features

### Slash Commands (Done!)
- [x] Command parsing infrastructure (`gateway/src/commands.ts`)
- [x] Directive parsing (`gateway/src/directives.ts`)
- [x] `/new` and `/reset` - Reset session
- [x] `/compact [N]` - Compact to last N messages
- [x] `/stop` - Stop command (placeholder, needs run cancellation)
- [x] `/status` - Show session info
- [x] `/model [name]` - Show/set model with aliases
- [x] `/think [level]` - Set thinking level
- [x] `/help` - Show available commands
- [x] Inline directives (`/think:high`, `/model:opus`)
- [x] Commands work in both `channel.inbound` AND `chat.send`
- [x] CLI updated to handle command responses

### Session Management
- [x] R2 bucket setup and storage helpers
- [x] Enhanced session state schema
- [x] Token tracking
- [x] Per-session settings
- [x] Session reset with archiving
- [x] Session stats/get RPC methods
- [x] Auto-reset policies (daily/idle)
- [x] Session compact
- [x] Session history
- [x] Session preview
- [x] CLI commands for session management

### WhatsApp Channel
- [x] Baileys integration with Workers shims
- [x] QR code login flow
- [x] Gateway channel connection
- [x] Message routing (inbound/outbound)
- [x] Keep-alive alarm to prevent hibernation
- [x] Bearer token auth for management API
- [x] Image support (download, R2 storage, send to LLM)
- [x] Voice message transcription (Workers AI Whisper)
- [x] Custom media decryption (Workers-compatible, no Node.js streams)

### Gateway
- [x] Channel mode connection
- [x] `channel.inbound` / `channel.outbound` events
- [x] Session key generation (clawdbot-compatible format)
- [x] Channel registry
- [x] Auth token support (`auth.token` config)

### Agent Workspace (Phase 1 Done!)
- [x] Workspace loading from R2 (`gateway/src/workspace.ts`)
- [x] `loadAgentWorkspace()` - Loads AGENTS.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md
- [x] `buildSystemPromptFromWorkspace()` - Combines files into system prompt
- [x] Daily memory loading (today + yesterday)
- [x] Main session security (`isMainSession()`) - MEMORY.md only in DMs/CLI
- [x] Template workspace files uploaded for `main` agent

---

## Remaining TODOs

### Critical: Heartbeat & Channel Security (clawdbot parity)

These items are required for a production-ready heartbeat system that matches clawdbot's behavior.

#### 1. WhatsApp Allowlist Filtering (SECURITY) ✅ DONE
**Status:** Implemented

- Added `channels.whatsapp.dmPolicy` ("open" | "allowlist")
- Added `channels.whatsapp.allowFrom` array
- Messages from non-allowed senders are silently blocked
- E164 normalization handles both `+31628552611` and `31628552611@s.whatsapp.net`

**Usage:**
```bash
gsv config set channels.whatsapp.dmPolicy allowlist
gsv config set channels.whatsapp.allowFrom '["+31628552611"]'
```

---

#### 1b. Pairing Flow (Enhancement) ✅ DONE
**Status:** Implemented

- Added `dmPolicy: "pairing"` option (default)
- Pending pairing requests stored in `PersistedObject<Record<string, PendingPair>>`
- Unknown senders get "awaiting approval" message
- CLI commands: `gsv pair list`, `gsv pair approve`, `gsv pair reject`
- On approval: adds to `allowFrom`, sends confirmation message to user
- Fixed WhatsApp LID JID handling: uses original JID for replies, senderPn for allowlist

**Usage:**
```bash
gsv config set channels.whatsapp.dmPolicy pairing
gsv pair list
gsv pair approve whatsapp +31649988417
```

---

#### 2. Last Active Channel Tracking ✅ DONE
**Status:** Implemented

- Gateway tracks `lastActiveContext[agentId]` with channel, accountId, peer, sessionKey, timestamp
- Updated on every inbound message
- Visible in `gsv heartbeat status`
- Heartbeat uses these to resolve delivery target

**Implementation:**
1. Add `lastActiveContext` to Gateway persisted state:
   ```typescript
   lastActiveContext: {
     agentId: string;
     channel: "whatsapp" | "cli" | etc;
     accountId: string;
     peer: PeerInfo;
     timestamp: number;
   } | null;
   ```
2. Update in `handleChannelInbound()` after successful routing
3. Expose via `heartbeat.status` for debugging

**Files to modify:**
- `gateway/src/gateway.ts` - Add `lastActiveContext` state, update on inbound

---

#### 3. Fix Heartbeat to Deliver Responses
**Priority:** High - Heartbeat runs but responses go nowhere

**Problem:** Current heartbeat uses isolated session `agent:main:heartbeat:system:internal`. This session:
- Has no connected WebSocket clients
- Has no `pendingChannelResponses` entry
- Response gets logged but not delivered

**Clawdbot approach:**
- Heartbeat runs in the **main session** (`agent:main:main`)
- Uses `lastChannel`/`lastTo` from session to route response
- Strips `HEARTBEAT_OK` token from response
- Suppresses short acks (< 300 chars)
- Deduplicates repeated responses within 24h

**Implementation:**
1. Change heartbeat session key from `agent:{agentId}:heartbeat:system:internal` to `agent:{agentId}:main` (or configurable)
2. After agent responds, check if it's a heartbeat run:
   - If response contains `HEARTBEAT_OK` and is short, suppress delivery
   - Otherwise, use `lastActiveContext` to route to channel
3. Add heartbeat tracking in session:
   ```typescript
   lastHeartbeatText?: string;
   lastHeartbeatSentAt?: number;
   ```
4. Skip delivery if same text within 24h (dedupe)

**Files to modify:**
- `gateway/src/gateway.ts` - Change heartbeat session, add delivery routing
- `gateway/src/heartbeat.ts` - Add response filtering logic
- `gateway/src/session.ts` - Add heartbeat tracking fields

---

#### 4. Heartbeat Skip Optimizations ✅ DONE
**Status:** Implemented

Skip checks added to `runHeartbeat()` in `gateway/src/gateway.ts`:
1. **Outside active hours** - Skip if outside configured `activeHours` (unless manual trigger)
2. **Empty HEARTBEAT.md** - Skip if file missing or only has comments/headers
3. **Session busy** - Skip if session `isProcessing` or has queued messages

Helper functions in `gateway/src/workspace.ts`:
- `loadHeartbeatFile()` - Load HEARTBEAT.md from R2
- `isHeartbeatFileEmpty()` - Check if content is effectively empty

`HeartbeatResult` type extended with `error?: string` field.

---

#### 5. Message Queue System ✅ DONE
**Status:** Implemented

Prevents race conditions when multiple messages arrive rapidly or heartbeat fires during processing.

**Implementation in `gateway/src/session.ts`:**
- `messageQueue: QueuedMessage[]` - PersistedObject for queued messages
- `isProcessing: boolean` - Flag to track if currently processing
- `chatSend()` queues messages if busy, returns `{ queued: true, queuePosition }`
- `processNextQueued()` processes queue after each message completes
- `stats()` RPC returns `isProcessing` and `queueSize`

**Gateway integration:**
- Heartbeat skip check uses `session.stats()` to check if busy

---

#### 5b. Identity Links (Cross-Channel Session Routing) ✅ DONE
**Status:** Implemented

Routes multiple channel identities to a single session for the same person.

**Config:**
```bash
gsv config set session.identityLinks.steve '["+31628552611", "telegram:123456789"]'
```

**Implementation:**
- `gateway/src/config.ts` - Added `resolveLinkedIdentity(config, channel, peerId)` helper
- `gateway/src/gateway.ts` - `buildSessionKeyFromChannel()` checks identity links
- Session key becomes `agent:{agentId}:{canonicalName}` when matched

---

#### 6. Inject HEARTBEAT.md into System Prompt
**Priority:** Medium - Agent can see heartbeat instructions

**Current state:** Workspace loading includes SOUL.md, AGENTS.md, etc. but not HEARTBEAT.md.

**Implementation:**
1. In `loadAgentWorkspace()`, also load `HEARTBEAT.md`
2. In `buildSystemPromptFromWorkspace()`, include heartbeat section (only for heartbeat runs or always?)
3. Alternative: Agent reads it via file tools when prompted

**Decision needed:** Always inject, or only inject during heartbeat runs?

**Files to modify:**
- `gateway/src/workspace.ts` - Load HEARTBEAT.md
- `gateway/src/session.ts` - Pass heartbeat context flag

---

### High Priority

#### 7. PDF/Document Support
PDFs and documents are downloaded and stored in R2, but not sent to the LLM.

**Current state:**
- WhatsApp channel downloads documents via custom Workers-compatible decryption
- Documents stored in R2 with `type: "document"`
- `buildUserMessage()` only processes images and audio, ignores documents

**Implementation:**
1. Add document handling in `session.ts` `buildUserMessage()`
2. Format as Anthropic `document` content block (base64 PDF)
3. Consider text extraction fallback for non-Anthropic providers

**Files to modify:**
- `gateway/src/session.ts` - Add document handling in `buildUserMessage()`

#### 2. Video Support
Videos are downloaded but not sent to LLM (similar to documents).

**Implementation:**
- Could extract frames and send as images
- Or wait for native video support in LLM APIs

#### 9. Run Cancellation (`/stop`)
Currently `/stop` is a placeholder. Need to implement actual run cancellation.

**Implementation:**
- Track current `runId` in Session
- Add `session.abort(runId)` RPC method
- Cancel pending tool calls
- Clean up partial state

#### 10. Thinking Level Actually Used
The `/think` command sets `thinkingLevel` in session settings, but it's not passed to the LLM yet.

**Implementation:**
- Pass thinking level to `completeSimple()` options
- Map levels to Claude's extended thinking parameters

---

### Medium Priority

#### 11. Session Scope Configuration
Add configurable session scoping.

```typescript
session: {
  scope: "per-sender" | "global";
  dmScope: "main" | "per-peer" | "per-channel-peer";
}
```

#### 12. Per-Chat-Type Reset Policies
Different reset policies for DMs vs groups.

```typescript
session: {
  resetByType: {
    dm: { mode: "idle", idleMinutes: 120 },
    group: { mode: "daily", atHour: 4 },
  }
}
```

#### 13. Typing Indicators ✅ DONE (Basic)
**Status:** Partially Implemented

Shows "typing..." in WhatsApp while LLM is processing.

**Implemented:**
- `gateway/src/types.ts` - Added `ChannelTypingPayload` type
- `gateway/src/gateway.ts` - Added `sendTypingToChannel()`, called before `chatSend()`
- `channels/whatsapp/src/gateway-client.ts` - Handle `channel.typing` event
- `channels/whatsapp/src/whatsapp-account.ts` - `handleTyping()` calls `sock.sendPresenceUpdate("composing", jid)`

**Still TODO (from OpenClaw patterns):**
- [ ] Send `typing=false` when response completes (currently only sends start)
- [ ] Typing TTL - auto-stop after max duration (2 min)
- [ ] Typing mode resolution: "never" | "instant" | "message" | "thinking"
- [ ] Typing suppression for heartbeat responses
- [ ] Refresh typing indicator during long tool executions

#### 14. `/usage` Command
Show detailed token usage and estimated cost.

---

### Lower Priority

#### 15. Message Debouncing
Handle rapid message bursts gracefully.

```typescript
messages: {
  queue: { mode: "debounce", debounceMs: 500 }
}
```

#### 16. `/verbose` Command
Toggle verbose mode for debugging.

#### 17. `/whoami` Command
Show sender ID and channel info.

#### 18. Identity Links ✅ DONE
See section 5b above - implemented.

---

## New Features from OpenClaw Analysis

These patterns were identified from the OpenClaw (formerly Clawdbot) codebase analysis.

### Heartbeat Improvements

#### 19. Heartbeat Coalescing
**Priority:** Medium - Prevents thundering herd

OpenClaw uses a 250ms coalesce window to prevent rapid-fire heartbeat triggers.

```typescript
// Coalesce multiple wake requests into one
export function requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }) {
  pendingReason = opts?.reason ?? pendingReason ?? "requested";
  schedule(opts?.coalesceMs ?? 250); // Default 250ms
}
```

**Implementation:**
- Add debounce to `scheduleHeartbeat()` in Gateway
- Coalesce rapid trigger requests

#### 20. Heartbeat Response Deduplication
**Priority:** Medium - Saves API costs and prevents spam

Skip delivery if same response text was sent within 24h.

```typescript
// Track in session or heartbeat state
lastHeartbeatText?: string;
lastHeartbeatSentAt?: number;

// Skip if duplicate
if (responseText === lastHeartbeatText && 
    Date.now() - lastHeartbeatSentAt < 24 * 60 * 60 * 1000) {
  return { skipped: true, reason: "duplicate" };
}
```

### Typing Indicator Improvements

#### 21. Typing Stop Event
**Priority:** High - Complete the typing lifecycle

Currently we only send `typing=true`. Need to send `typing=false` when:
- Response is complete
- Error occurs
- Max TTL reached

**Implementation:**
- Call `sendTypingToChannel(..., false)` after response delivered
- Add to error handlers

#### 22. Typing TTL (Time-To-Live)
**Priority:** Medium - Prevents stuck typing indicators

Auto-stop typing after max duration (2 minutes).

```typescript
// TypingController pattern from OpenClaw
const typing = {
  typingIntervalSeconds: 6,    // Refresh interval (WhatsApp needs this)
  typingTtlMs: 2 * 60_000,     // Max typing duration
};
```

### Media Pipeline

#### 23. PDF Text Extraction + Image Fallback
**Priority:** High - Documents already in R2, just not sent to LLM

OpenClaw pattern:
1. Try text extraction first (pdf.js)
2. If text is sparse (< 200 chars), render pages as images
3. Send both text + images to vision models

```typescript
const PDF_LIMITS = {
  maxPages: 4,
  maxPixels: 4_000_000,
  minTextChars: 200,  // Below this, render as images
};

async function extractPdfContent(buffer: Buffer) {
  // 1. Extract text from each page
  // 2. If text.length < minTextChars, render pages as PNG
  // 3. Return { text, images }
}
```

**Implementation:**
- Add `pdf.js` or similar to gateway (check Workers compatibility)
- Update `buildUserMessage()` to handle documents
- Format as Anthropic document blocks or image blocks

#### 24. Video Frame Extraction
**Priority:** Lower - Complex, may wait for native LLM support

Extract keyframes from video and send as images.

### Queuing Improvements

#### 25. Lane-Based Command Queue
**Priority:** Medium - Better than simple isProcessing flag

OpenClaw uses lanes with configurable concurrency:

```typescript
enum CommandLane {
  Main = "main",        // Primary auto-reply (concurrency: 1)
  Cron = "cron",        // Scheduled jobs (concurrency: 3)
  Subagent = "subagent", // Nested agent calls (concurrency: 2)
}
```

Benefits:
- Cron jobs don't block interactive messages
- Subagent calls have their own capacity
- Per-session lanes prevent cross-session interference

### Scheduled Tasks

#### 26. Cron Jobs System
**Priority:** Medium - Scheduled autonomous tasks

Full cron system with isolated sessions:

```typescript
type CronJob = {
  id: string;
  name: string;
  agentId?: string;
  enabled: boolean;
  schedule: 
    | { kind: "at"; atMs: number }           // One-time
    | { kind: "every"; everyMs: number }     // Interval
    | { kind: "cron"; expr: string };        // Cron expression
  sessionTarget: "main" | "isolated";
  payload: {
    kind: "agentTurn";
    message: string;
  };
};
```

**CLI commands:**
```bash
gsv cron list
gsv cron add "Daily summary" --every 24h --message "Summarize today's activity"
gsv cron run <id>
gsv cron disable <id>
```

### Installation & Distribution

#### 27. Installation Wizard
**Priority:** HIGH - Required for sharing with others

Create a smooth onboarding experience:

```bash
# Option A: Install CLI, wizard deploys everything
curl -sSL https://gsv.dev/install.sh | sh
gsv init

# Option B: One-click deploy to Cloudflare
# Deploy button that forks and deploys
```

**Wizard steps:**
1. Check prerequisites (Cloudflare account, wrangler auth)
2. Create R2 bucket
3. Deploy gateway worker
4. Deploy WhatsApp channel (optional)
5. Set secrets (LLM API key, auth token)
6. Generate initial config
7. Show connection instructions

#### 28. CLI Binary Distribution
**Priority:** HIGH

Options:
- GitHub Releases (current) - manual download
- `cargo install gsv` - Rust users
- Homebrew tap - macOS users
- curl installer script - universal
- npm wrapper package - Node users

#### 29. Update Mechanism
**Priority:** Medium

How to update:
- CLI: `gsv update` or re-run installer
- Gateway: `gsv deploy` or GitHub Actions
- Config: synced via CLI

---

## Feature Comparison: GSV vs Clawdbot

### Slash Commands

| Command | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| `/new`, `/reset` | Reset session | ✅ | Done |
| `/compact` | Compact context | ✅ | Done |
| `/stop` | Stop current run | ⚠️ | Placeholder |
| `/status` | Show status | ✅ | Done |
| `/model` | Show/set model | ✅ | Done |
| `/think` | Set thinking level | ✅ | Done (not wired to LLM) |
| `/help` | Show commands | ✅ | Done |
| `/verbose` | Toggle verbose | ❌ | TODO |
| `/usage` | Token/cost summary | ❌ | TODO |
| `/whoami` | Show sender ID | ❌ | TODO |

### Config Options

| Feature | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| Model settings | ✅ | ✅ | Done |
| API keys | ✅ | ✅ | Done |
| Timeouts | ✅ | ✅ | Done |
| System prompt | ✅ | ✅ | Done |
| Thinking levels | ✅ | ⚠️ | Command done, not wired |
| Session scope | ✅ | ❌ | TODO |
| DM scope | ✅ | Hardcoded | TODO config |
| Typing indicators | ✅ | ✅ | Done |
| Message queue | ✅ | ✅ | Done |
| Auth token | ✅ | ✅ | Done |

### Session Management

| Feature | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| Manual reset | ✅ | ✅ | Done |
| Daily reset | ✅ | ✅ | Done |
| Idle reset | ✅ | ✅ | Done |
| Per-chat-type policies | ✅ | ❌ | TODO |
| Token tracking | ✅ | ✅ | Done |
| Session archival | ✅ | ✅ | Done |
| Session compact | ✅ | ✅ | Done |

---

## Implementation Order

### Immediate (Heartbeat & Security) - DONE ✅
1. [x] **Allowlist filtering** - Security first! Stop random people from using the bot
2. [x] **Last active tracking** - Track where user last messaged from
3. [x] **Fix heartbeat delivery** - Route responses to last active channel
4. [x] **Pairing flow** - Let unknown senders request access, approve via CLI

### High Priority - DONE ✅
5. [x] **Identity links** - Route multiple channel identities to single session
6. [x] **Heartbeat skip optimizations** - Empty file, active hours, session busy
7. [x] **Message queue** - Prevent race conditions
8. [x] **Typing indicators** - Show "typing..." in WhatsApp

### Next Up - Installation & Polish
9. [ ] **Installation wizard** (`gsv init`) - Deploy gateway + configure secrets
10. [ ] **CLI binary distribution** - curl installer, GitHub releases
11. [ ] **Typing stop event** - Send `typing=false` when done
12. [ ] **PDF/document support** - Text extraction + image fallback

### Medium Priority - Feature Parity
13. [ ] Run cancellation for `/stop`
14. [ ] Inject HEARTBEAT.md into system prompt
15. [ ] `/usage` command - Token/cost summary
16. [ ] Wire thinking level to LLM
17. [ ] Heartbeat coalescing (250ms)
18. [ ] Heartbeat response deduplication (24h)
19. [ ] Typing TTL (auto-stop after 2min)

### Later - Advanced Features
20. [ ] Cron jobs system
21. [ ] Lane-based command queue
22. [ ] Video support (frame extraction?)
23. [ ] Session scope config
24. [ ] Message debouncing
25. [ ] Sticker support (treat as images)
26. [ ] `/verbose` command
27. [ ] `/whoami` command

---

## Agent Framework (Clawdbot Parity)

The core agent loop is done. Now we need the **agent identity and memory system** that makes agents persistent entities rather than stateless chatbots.

### Agent Workspace

Each agent needs a workspace directory in R2:

```
gsv-storage/
└── agents/{agentId}/
    ├── AGENTS.md       # Operating instructions (read every session)
    ├── SOUL.md         # Identity/personality (read every session)  
    ├── USER.md         # Info about the human
    ├── MEMORY.md       # Long-term curated memory (main session only)
    ├── TOOLS.md        # Local tool notes
    ├── HEARTBEAT.md    # Proactive check instructions
    ├── memory/
    │   └── YYYY-MM-DD.md   # Daily notes
    ├── sessions/
    │   └── {sessionId}.jsonl.gz   # Archived transcripts
    └── skills/
        └── {skillName}/
            └── SKILL.md   # Skill definitions
```

**Implementation:**
- [x] **1. Workspace loading** - Session reads AGENTS.md + SOUL.md + USER.md from R2 at start
- [x] **2. System prompt injection** - Combine workspace files into system prompt
- [x] **3. Daily memory loading** - Auto-load `memory/YYYY-MM-DD.md` (today + yesterday)
- [x] **4. MEMORY.md security** - Only load in "main session" (direct DM with owner)
- [x] **5. File tools in CLI** - Read, Write, Edit, Glob, Grep tools with workspace support
- [x] **6. `gsv mount` command** - Mount R2 to local workspace via rclone FUSE

### Multi-Agent Support

```typescript
// Config schema
agents: {
  list: [
    { id: "main", default: true },
    { id: "work", model: { provider: "anthropic", id: "claude-opus" } },
    { id: "research", systemPrompt: "You are a research assistant..." }
  ]
}

// Bindings map channels/chats to agents  
bindings: [
  { agentId: "work", match: { channel: "slack", accountId: "T123" } },
  { agentId: "research", match: { channel: "telegram", peer: { kind: "dm", id: "456" } } }
]
```

**Implementation:**
- [ ] **6. Agent config schema** - Add `agents.list[]` and `bindings[]` to config
- [ ] **7. Agent resolution** - Gateway resolves agentId from channel/peer match
- [ ] **8. Per-agent settings** - Model, system prompt, workspace path per agent
- [ ] **9. Agent isolation** - Each agent has separate workspace in R2

### Skills System (DONE!)

Skills are markdown files that provide context and instructions. The agent sees a list of available skills in its system prompt and reads the SKILL.md on-demand.

**Implemented:**
- [x] Skills loading from R2 (`agents/{agentId}/skills/*/SKILL.md`)
- [x] Global skills support (`skills/*/SKILL.md`)
- [x] YAML frontmatter parsing (name, description, always)
- [x] Skills list injected into system prompt
- [x] On-demand reading via `Read` tool

```yaml
# skills/web-search/SKILL.md
---
name: web-search
always: true
requires:
  env: [SERP_API_KEY]
---
# Web Search

Use web_search tool to find current information...
```

**Remaining:**
- [ ] **Skill eligibility** - Check `requires` conditions (env vars, tools)

### Heartbeat/Proactive Behavior

Agents should be able to check in periodically:

- [ ] **Heartbeat polls** - Scheduled messages that trigger agent to check HEARTBEAT.md
- [ ] **Proactive actions** - Agent can send messages without user prompting
- [ ] **Cron jobs** - Scheduled tasks with isolated sessions

### Implementation Order

**Phase 1: Basic Workspace (DONE!)**
1. ✅ Workspace loading (AGENTS.md, SOUL.md, USER.md, TOOLS.md)
2. ✅ System prompt injection from workspace files
3. ✅ Daily memory loading (today + yesterday)
4. ✅ Main session security for MEMORY.md
5. ✅ File tools in CLI (Read, Write, Edit, Glob, Grep)
6. ✅ `gsv mount` command for R2 FUSE mount
7. ✅ Skills loading and injection

**Phase 2: Multi-Agent**
- Agent config schema
- Agent resolution from bindings
- Per-agent workspaces

**Phase 3: Proactive**
- Heartbeat system
- Cron jobs

---

---

## Installation & Distribution Strategy

### The Challenge

GSV is a distributed system with multiple components:
1. **Gateway Worker** - Cloudflare Worker + Durable Objects
2. **WhatsApp Channel** - Separate Cloudflare Worker (optional)
3. **R2 Bucket** - Storage for workspace, media, archives
4. **CLI Binary** - Rust binary for local tools + chat
5. **Secrets** - LLM API keys, auth tokens

### Proposed Solution: CLI-Driven Wizard

```bash
# 1. Install CLI (one command)
curl -sSL https://gsv.dev/install.sh | sh

# 2. Run wizard (does everything else)
gsv init
```

### Wizard Flow (`gsv init`)

```
╔═══════════════════════════════════════════════════════════════╗
║                    GSV Setup Wizard                           ║
╚═══════════════════════════════════════════════════════════════╝

Step 1/6: Cloudflare Authentication
─────────────────────────────────────
? Do you have a Cloudflare account? (Y/n)
? Authenticate with Cloudflare:
  > Browser login (wrangler login)
  > API token (paste token)

Step 2/6: Create Resources  
─────────────────────────────────────
Creating R2 bucket: gsv-storage... ✓
Creating KV namespace: gsv-config... ✓

Step 3/6: Deploy Gateway
─────────────────────────────────────
Deploying gateway worker... ✓
Gateway URL: https://gsv-gateway.your-account.workers.dev

Step 4/6: Configure LLM
─────────────────────────────────────
? Select LLM provider:
  > Anthropic (Claude)
  > OpenAI
  > OpenRouter
? Enter API key: ****************************
Setting secret LLM_API_KEY... ✓

Step 5/6: Security
─────────────────────────────────────
? Generate auth token? (Y/n)
Auth token: gsv_xxxxxxxxxxxx
Setting secret AUTH_TOKEN... ✓

Step 6/6: WhatsApp (Optional)
─────────────────────────────────────
? Set up WhatsApp channel? (y/N)
  (You can do this later with: gsv channel add whatsapp)

╔══════════════════════════════════��════════════════════════════╗
║                    Setup Complete! 🎉                         ║
╠═══════════════════════════════════════════════════════════════╣
║  Gateway:  https://gsv-gateway.your-account.workers.dev       ║
║  Config:   ~/.config/gsv/config.json                          ║
║                                                               ║
║  Next steps:                                                  ║
║    gsv chat "Hello!"           # Start chatting               ║
║    gsv channel add whatsapp    # Add WhatsApp                 ║
║    gsv mount                   # Mount workspace locally      ║
╚═══════════════════════════════════════════════════════════════╝
```

### Component Distribution

| Component | Distribution Method | Update Method |
|-----------|--------------------|--------------| 
| CLI | curl installer / GitHub releases / cargo install | `gsv update` |
| Gateway | Deployed by wizard via wrangler | `gsv deploy gateway` |
| WhatsApp | Deployed by wizard via wrangler | `gsv deploy whatsapp` |
| Config | Local file + synced to KV | `gsv config set/get` |
| Workspace | R2 bucket | `gsv mount` (FUSE) |

### CLI Installation Script (`install.sh`)

```bash
#!/bin/sh
set -e

# Detect OS/arch
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Map to release names
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

# Download and install
RELEASE_URL="https://github.com/deathbyknowledge/gsv/releases/latest/download/gsv-$OS-$ARCH"
curl -sSL "$RELEASE_URL" -o /tmp/gsv
chmod +x /tmp/gsv
sudo mv /tmp/gsv /usr/local/bin/gsv

echo "GSV installed! Run 'gsv init' to get started."
```

### Alternative: Repo Clone + Deploy

For developers who want to customize:

```bash
git clone https://github.com/deathbyknowledge/gsv
cd gsv
./deploy.sh  # Deploys gateway + whatsapp
```

### Update Mechanism

```bash
# Update CLI
gsv update  # Downloads latest binary

# Update Gateway (redeploy)
gsv deploy gateway

# Update WhatsApp channel
gsv deploy whatsapp

# Check versions
gsv version
# CLI: 0.2.0
# Gateway: 0.2.0 (deployed 2026-02-01)
# WhatsApp: 0.2.0 (deployed 2026-02-01)
```

### Open Questions

1. **Domain**: Should we get `gsv.dev` or similar for the install script?
2. **Hosted option**: Offer a fully-hosted version for non-technical users?
3. **Wrangler dependency**: Wizard needs wrangler - bundle it or require install?
4. **Multi-account**: Support deploying to different CF accounts?

---

## Notes

- Session key format: `agent:{agentId}:{channel}:{peerKind}:{peerId}` (matches clawdbot)
- Commands parsed at Gateway for ALL entry points (channel.inbound + chat.send)
- Architecture is distributed (better than clawdbot's monolithic approach)
- Media files will be stored in R2 with signed URLs for LLM access
- Agent workspaces live in R2, mountable locally via `gsv mount` (rclone FUSE)
- Default workspace path: `~/gsv/` (configurable via `--workspace` or `GSV_WORKSPACE`)
- CLI file tools (Read, Write, etc.) resolve paths relative to workspace
