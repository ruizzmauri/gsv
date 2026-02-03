# GSV Roadmap

## What's Done

Core platform is working:
- Gateway + Session Durable Objects on Cloudflare
- Multi-provider LLM (Anthropic, OpenAI, Google via pi-ai)
- Rust CLI with tool namespacing (`macbook__Bash`, `server__Read`)
- WhatsApp channel (media, voice transcription, pairing flow)
- Agent workspace (SOUL.md, AGENTS.md, USER.md, MEMORY.md, skills)
- Session management (reset, compact, archive, token tracking)
- Slash commands (`/model`, `/think`, `/status`, `/help`, `/reset`, `/compact`)
- Heartbeat system (basic), typing indicators, message queue
- R2 FUSE mount for local workspace editing
- Installation via `install.sh` + Alchemy deployment

---

## GSV vs OpenClaw Gap Analysis

| Feature | OpenClaw | GSV | Priority |
|---------|----------|-----|----------|
| **Onboarding Wizard** | Interactive wizard with "hatching" | `install.sh` + manual config | High |
| **Multiple Channels** | WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams | WhatsApp only | High |
| **Web UI** | Full dashboard served by Gateway | None | High |
| **PDF/Document Support** | Text extraction + image fallback | Downloaded but not sent to LLM | High |
| **Run Cancellation** | `/stop` works | Done | Done |
| **Thinking Level** | `/think` wired to LLM | Done | Done |
| **Doctor Command** | Diagnose/repair config | None | Medium |
| **Cron Jobs** | Full scheduled task system | Heartbeat only | Medium |
| **Multi-agent Routing** | Route channels to different agents | Single agent | Medium |
| **Skills Registry** | ClawHub auto-discovery | Basic R2 loading | Low |
| **Voice** | Voice Wake + Talk Mode | None | Future |
| **Canvas** | A2UI live visual workspace | None | Future |
| **Native Apps** | macOS/iOS/Android companions | CLI only | Future |
| **Browser Control** | CDP automation | None | Future |
| **Sandbox Mode** | Docker isolation for groups | None | Future |

---

## Roadmap

### Phase 1: Polish (Current)

#### 1. Thinking Level - DONE
`/think` and `/t:level` directives now pass reasoning level to pi-ai.
Levels: off, minimal, low, medium, high, xhigh

#### 2. Typing Stop Event - DONE
`typing=false` is sent when:
- Response completes (final state)
- Error occurs during processing
- Session errors out

#### 3. Run Cancellation (`/stop`) - DONE
`/stop` cancels the current agent run:
- Sets `aborted` flag in `currentRun` state
- Clears pending tool calls
- Agent loop checks flag at key points and exits early
- Broadcasts "Run cancelled by user" error event

#### 4. PDF/Document Support
Documents are in R2, just need to send to LLM:
- Format as Anthropic `document` content block
- Consider text extraction for non-Anthropic providers

---

### Phase 2: Channels

#### 5. Telegram Channel
Second most important channel. Similar architecture to WhatsApp:
- Separate Cloudflare Worker
- grammy or telegraf for bot API
- Reuse session routing logic

#### 6. Discord Channel
- discord.js in Workers
- Guild/channel routing
- Slash command support

#### 7. Channel Plugin Architecture
Make it easy to add channels:
```typescript
interface ChannelPlugin {
  id: string;
  connect(gateway: WebSocket): Promise<void>;
  sendMessage(peer: PeerInfo, content: string): Promise<void>;
  // ...
}
```

---

### Phase 3: Web UI

#### 8. Basic Web Dashboard
Served directly from Gateway Worker:
- Session list and preview
- Config editor
- Real-time chat interface
- Token usage stats

#### 9. Onboarding Wizard
Guided setup experience:
1. Cloudflare auth (OAuth or API token)
2. Deploy Gateway + R2
3. Configure LLM provider
4. Optional: Add channels
5. "Hatch" - first message with BOOTSTRAP.md

---

### Phase 4: Multi-Agent

#### 10. Agent Config Schema
```typescript
agents: {
  list: [
    { id: "main", default: true },
    { id: "work", model: "claude-opus" },
  ]
}

bindings: [
  { agentId: "work", match: { channel: "slack" } }
]
```

#### 11. Agent Resolution
Gateway resolves agentId from channel/peer match rules.

#### 12. Per-Agent Workspaces
Each agent has isolated R2 workspace.

---

### Phase 5: Automation

#### 13. Cron Jobs System
```typescript
type CronJob = {
  id: string;
  schedule: "at" | "every" | "cron";
  sessionTarget: "main" | "isolated";
  message: string;
};
```

CLI: `gsv cron list`, `gsv cron add`, `gsv cron run`

#### 14. Doctor Command
Diagnose and repair common issues:
- Config validation
- Gateway connectivity
- R2 permissions
- Channel status

---

### Phase 6: Future

These are nice-to-haves, not blocking:

- **Voice**: ElevenLabs TTS, Whisper STT
- **Canvas**: A2UI live workspace
- **Native Apps**: macOS menu bar, iOS/Android nodes
- **Browser Control**: CDP automation
- **Sandbox**: Docker isolation for untrusted sessions
- **Skills Registry**: Remote skill discovery

---

## Quick Wins

Small improvements that add polish:

- [ ] `/usage` command - Token/cost summary
- [ ] `/verbose` toggle - Debug output
- [ ] `/whoami` - Show sender/channel info
- [ ] Typing TTL - Auto-stop after 2 min
- [ ] Heartbeat deduplication - Skip same response within 24h
- [ ] Message debouncing - Coalesce rapid messages
- [ ] Sticker support - Treat as images

---

## Architecture Notes

### GSV Advantages Over OpenClaw

| Feature | Why It's Better |
|---------|-----------------|
| **Cloudflare Edge** | Global, no server to run, hibernation |
| **Tool Namespacing** | `macbook__Bash` vs `server__Bash` - LLM picks target |
| **Distributed** | DOs scale automatically, wake on demand |
| **No Local Install** | Gateway in cloud, CLI is just a client |
| **R2 Mount** | Edit workspace locally, syncs to cloud |

### Key Design Decisions

1. **Gateway is singleton** - All routing through one DO
2. **Sessions are isolated** - Each conversation in own DO
3. **Tools namespaced by node** - Multiple machines, LLM chooses
4. **Workspace in R2** - Persistent, mountable, survives deploys
5. **Channels are Workers** - Separate deploys, independent scaling
