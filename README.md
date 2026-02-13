# 🤖 MyBot — Personal AI Assistant

A **secure, lightweight personal AI assistant** that runs on your own machine and connects to WhatsApp and Telegram.

Built from scratch, inspired by [OpenClaw](https://github.com/openclaw/openclaw), [nanobot](https://github.com/HKUDS/nanobot), and [NanoClaw](https://github.com/qwibitai/nanoclaw).

---

## Features

| Feature | Status |
|---------|--------|
| WhatsApp + Telegram | ✅ |
| Multi-provider AI (Anthropic, OpenAI, OpenRouter, Google) | ✅ |
| Docker container sandbox isolation | ✅ |
| Allowlist security gate + pairing codes | ✅ |
| Persistent memory across conversations | ✅ |
| Web search (Brave API) | ✅ |
| Scheduled tasks (cron) | ✅ |
| Agent Swarms (parallel multi-agent) | ✅ |
| Safe bash execution (sandboxed) | ✅ |
| Obsidian-compatible memory vault | ✅ |
| Cross-platform (Linux, macOS, Windows/WSL2) | ✅ |

---

## Security Model

MyBot uses **two layers of security**:

**Layer 1 — Allowlist + Pairing** (application level)
- Only users in your `.env` allowlist (or approved via pairing) can use the bot
- Unknown users get a pairing code; you approve them with `approve <code>`
- Groups: bot only responds to the trigger word (default: `@bot`)

**Layer 2 — Docker Container Isolation** (OS level)
- Agent tool execution (bash, file operations) runs inside isolated Docker containers
- Containers have: no network access, read-only root filesystem, non-root user, CPU/memory limits
- Even if someone tricks the bot into running code, they're sandboxed
- Web search tool uses a separate container with network enabled

---

## Prerequisites

- **Linux, macOS, or Windows with WSL2**
- **Node.js ≥ 22**
- **Docker** (Docker Engine on Linux, Docker Desktop on macOS/Windows)
- At least one AI provider API key

### Platform-Specific Notes

**Linux (Native)** ✅ Best performance, native Docker support
- Install Docker: `curl -fsSL https://get.docker.com | sh`
- Add user to docker group: `sudo usermod -aG docker $USER`

**macOS** ✅ Works great with Docker Desktop
- Install Docker Desktop from [docker.com](https://docker.com)

**Windows (WSL2)** ✅ Recommended over native Windows
- Install WSL2: `wsl --install Ubuntu`
- Install Docker Desktop with WSL2 integration

---

## Quick Start

### 1. Install Docker

**Linux:**
```bash
# Install Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER  # Logout/login after this

# Verify
docker --version
```

**macOS / Windows:**
Download [Docker Desktop](https://www.docker.com/products/docker-desktop)
- Windows: Enable WSL2 integration in Settings
- Docker Desktop → Settings → Resources → WSL Integration → Enable your distro

### 2. Clone and install

```bash
git clone <your-repo>
cd mybot
npm install
```

### 3. Run the onboarding wizard

```bash
npm run onboard
```

The wizard asks for your API keys and creates `.env`.

### 4. Build the sandbox Docker image

```bash
docker build -t mybot-sandbox -f docker/Dockerfile.sandbox docker/
```

### 5. Start the bot

```bash
npm run gateway
```

For WhatsApp: scan the QR code that appears in your terminal.

For development with auto-reload:
```bash
npm run dev
```

---

## Configuration

All configuration lives in `.env`. Copy `.env.example` to get started:

```bash
cp .env.example .env
```

### Minimum required config

```env
# At least one AI provider:
ANTHROPIC_API_KEY=sk-ant-...

# Your WhatsApp number (you'll scan QR to link):
WHATSAPP_ALLOWED_NUMBERS=+1234567890

# OR/AND Telegram:
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

### Full config reference → `.env.example`

---

## How It Works

```
WhatsApp (Baileys)  ──┐
                      ├──▶ Security Gate ──▶ Agent Loop ──▶ LLM (Claude/GPT/etc)
Telegram (grammY)   ──┘         │                │
                                │           Tools execute in
                         Allowlist +        Docker sandbox
                         Pairing codes      (no host access)
```

The **Gateway** is a single Node.js process. There are no microservices, message queues, or abstraction layers. The whole system is in `src/` — readable in one sitting.

---

## Available Tools

The AI can use these tools automatically:

| Tool | Description |
|------|-------------|
| `web_search` | Search the web via Brave API |
| `memory_remember` | Save a fact to long-term memory |
| `memory_recall` | Look up a saved memory |
| `memory_list` | List all memories |
| `memory_forget` | Delete a memory |
| `bash` | Run shell commands (sandboxed in Docker) |
| `cron_add` | Create a scheduled task |
| `cron_list` | List scheduled tasks |
| `cron_remove` | Remove a scheduled task |
| `agent_swarm` | Run a team of parallel specialized agents |

---

## Agent Swarms

Ask the bot to tackle complex tasks with multiple agents:

```
@bot research the latest AI developments and write me a detailed weekly briefing with analysis
```

The swarm tool automatically decomposes this into agents (e.g., researcher + analyst + writer), runs them in parallel, and synthesizes the results.

You can also define custom agents:
```
@bot I need a 3-agent swarm: one to research competitors, one to analyze their pricing, one to write recommendations
```

---

## Scheduled Tasks

Create recurring tasks via chat:

```
@bot every weekday morning at 9am, check the weather and send me a briefing
@bot every Monday, summarize last week and help me plan this week
@bot every hour, check my notes folder and alert me if anything needs attention
```

Manage tasks:
```
@bot list my scheduled tasks
@bot remove the weather task
```

---

## Security Details

### Container specs (per bash execution)

```
--memory 512m           # Memory limit
--cpus 0.5              # CPU limit  
--network none          # No internet access
--read-only             # Read-only root filesystem
--tmpfs /tmp:size=100m  # Writable /tmp only
--user 1000:1000        # Non-root user
--security-opt no-new-privileges
```

### Allowlist modes

**`DM_POLICY=strict`** (default): Only numbers/IDs in `.env` can use the bot. Unknown users are silently ignored.

**`DM_POLICY=pairing`**: Unknown users receive a pairing code. Approve with:
```bash
# In the bot's terminal or via a future admin command
```

---

## Project Structure

```
mybot/
├── src/
│   ├── index.ts              # Main gateway entry point
│   ├── types.ts              # All TypeScript types
│   ├── agent/
│   │   ├── loop.ts           # Core agent loop (LLM ↔ tools)
│   │   └── llm.ts            # Multi-provider LLM client
│   ├── channels/
│   │   ├── telegram.ts       # Telegram bot (grammY)
│   │   └── whatsapp.ts       # WhatsApp (Baileys)
│   ├── security/
│   │   └── gate.ts           # Allowlist + pairing + Docker runner
│   ├── tools/
│   │   └── registry.ts       # All built-in tools
│   ├── swarm/
│   │   └── orchestrator.ts   # Agent swarm logic
│   ├── scheduler/
│   │   └── cron.ts           # Cron job scheduler
│   ├── memory/
│   │   └── db.ts             # SQLite database layer
│   ├── config/
│   │   └── loader.ts         # Config loader
│   ├── utils/
│   │   └── logger.ts         # Logger
│   └── cli/
│       └── onboard.ts        # Setup wizard
├── docker/
│   └── Dockerfile.sandbox    # Isolated execution environment
├── .env.example              # Config template
├── Dockerfile                # Bot container
├── docker-compose.yml        # Compose for easy deployment
└── package.json
```

---

## Adding New Features

**New tool**: Add to `src/tools/registry.ts`. Implement the `Tool` interface.

**New channel**: Create `src/channels/yourplatform.ts`. Implement `start()`, `stop()`, `send()`, and call `onMessage(incoming)` for each message.

**New AI provider**: Add a case in `src/agent/llm.ts` → `chat()`.

---

## Troubleshooting

**WhatsApp keeps disconnecting**: Make sure you're not using WhatsApp Web on another device simultaneously. WhatsApp only allows one linked session at a time.

**Docker sandbox fails**: Run `docker info` in WSL2 to verify Docker is accessible. Ensure Docker Desktop has WSL2 integration enabled for your Ubuntu distro.

**No response in groups**: Make sure your message includes the trigger word (default: `@bot`).

**Model not found**: Set `DEFAULT_MODEL` to match your provider. Examples:
- Anthropic: `claude-opus-4-5`
- OpenAI: `gpt-4o`
- OpenRouter: `anthropic/claude-opus-4-5`

---

## License

MIT
