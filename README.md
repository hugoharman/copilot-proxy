# copilot-proxy

OpenAI-compatible API proxy using your **GitHub Copilot subscription** to access Claude, GPT, and other models — no API key needed.

## How it works

1. Uses your GitHub token to get a Copilot API token via `https://api.github.com/copilot_internal/v2/token`
2. Extracts the API base URL from the token (`proxy-ep` field)
3. Calls the Anthropic Messages API at `https://api.individual.githubcopilot.com` with the Copilot token
4. Translates between OpenAI format and Anthropic format

Reverse-engineered from OpenClaw's `@mariozechner/pi-ai` GitHub Copilot provider.

## Setup

```bash
npm install
```

### Option 1: Login via device code (easiest)
```bash
npm run login
```
Opens GitHub device code flow, saves token to `.env` automatically.

### Option 2: Use existing GitHub token
```bash
echo "GITHUB_TOKEN=gho_xxxx" > .env
```

## Run

```bash
npm start
```

Runs on `http://0.0.0.0:3457` (LAN only).

## Usage

```bash
curl http://localhost:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"Hello!"}]}'
```

## Available Models

- `claude-opus-4.6`
- `claude-sonnet-4.5`
- `claude-haiku-4.5`
- `gpt-4o`
- `gpt-4.1`
- `o3-mini`
