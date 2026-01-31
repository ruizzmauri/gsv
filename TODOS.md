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

### Gateway
- [x] Channel mode connection
- [x] `channel.inbound` / `channel.outbound` events
- [x] Session key generation (clawdbot-compatible format)
- [x] Channel registry
- [x] Auth token support (`auth.token` config)

---

## Remaining TODOs

### High Priority

#### 1. WhatsApp Media/Voice Support
Support receiving and processing media messages from WhatsApp.

**Message types to handle:**
- Images with captions
- Audio messages (voice notes) → transcribe with Whisper
- Videos with captions
- Documents

**Implementation:**
1. Download media via Baileys `downloadMediaMessage()`
2. Upload to R2, get signed URL (1hr expiry)
3. For audio: transcribe with Whisper API or Workers AI
4. Send to LLM as multi-modal content

**Files to modify:**
- `channels/whatsapp/src/whatsapp-account.ts` - Handle media in `handleMessagesUpsert()`
- `channels/whatsapp/wrangler.jsonc` - Add R2 binding
- `gateway/src/types.ts` - Extend `ChannelInboundParams` with media

#### 2. Run Cancellation (`/stop`)
Currently `/stop` is a placeholder. Need to implement actual run cancellation.

**Implementation:**
- Track current `runId` in Session
- Add `session.abort(runId)` RPC method
- Cancel pending tool calls
- Clean up partial state

#### 3. Thinking Level Actually Used
The `/think` command sets `thinkingLevel` in session settings, but it's not passed to the LLM yet.

**Implementation:**
- Pass thinking level to `completeSimple()` options
- Map levels to Claude's extended thinking parameters

---

### Medium Priority

#### 4. Session Scope Configuration
Add configurable session scoping.

```typescript
session: {
  scope: "per-sender" | "global";
  dmScope: "main" | "per-peer" | "per-channel-peer";
}
```

#### 5. Per-Chat-Type Reset Policies
Different reset policies for DMs vs groups.

```typescript
session: {
  resetByType: {
    dm: { mode: "idle", idleMinutes: 120 },
    group: { mode: "daily", atHour: 4 },
  }
}
```

#### 6. Typing Indicators
Send typing indicators while processing.

- Gateway sends `channel.typing` event
- WhatsApp channel calls `sock.sendPresenceUpdate("composing", jid)`

#### 7. `/usage` Command
Show detailed token usage and estimated cost.

---

### Lower Priority

#### 8. Message Queue/Debouncing
Handle rapid message bursts gracefully.

```typescript
messages: {
  queue: { mode: "debounce", debounceMs: 500 }
}
```

#### 9. `/verbose` Command
Toggle verbose mode for debugging.

#### 10. `/whoami` Command
Show sender ID and channel info.

#### 11. Identity Links
Map cross-platform identities to single session.

```typescript
session: {
  identityLinks: {
    "steve": ["whatsapp:+123", "telegram:456"]
  }
}
```

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
| Typing indicators | ✅ | ❌ | TODO |
| Message queue | ✅ | ❌ | TODO |
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

### Next Up
1. [ ] Wire thinking level to LLM calls
2. [ ] WhatsApp media download and R2 storage
3. [ ] Audio transcription (Whisper)
4. [ ] Run cancellation for `/stop`

### Later
5. [ ] Session scope config
6. [ ] Typing indicators
7. [ ] `/usage` command
8. [ ] Message queue/debouncing

---

## Notes

- Session key format: `agent:{agentId}:{channel}:{peerKind}:{peerId}` (matches clawdbot)
- Commands parsed at Gateway for ALL entry points (channel.inbound + chat.send)
- Architecture is distributed (better than clawdbot's monolithic approach)
- Media files will be stored in R2 with signed URLs for LLM access
