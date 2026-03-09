import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { getGitHubToken, getCopilotToken } from "./copilot-auth.js";
import { streamChat } from "./copilot-client.js";
import { MODELS } from "./models.js";

// Load .env
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, "..", ".env");
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const app = express();

// LAN-only access
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const clean = ip.replace(/^::ffff:/, "");
  const isAllowed =
    clean === "::1" ||
    clean === "127.0.0.1" ||
    clean.startsWith("10.") ||
    clean.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean);
  if (!isAllowed) {
    return res.status(403).json({ error: { message: "Access denied — LAN only" } });
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

const PORT = parseInt(process.env.PORT || "3457", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Cache the copilot token in memory
let cachedCopilot = null;

async function ensureCopilotToken() {
  const ghToken = getGitHubToken();
  if (!ghToken) throw new Error("No GitHub token. Set GITHUB_TOKEN, GH_TOKEN, or COPILOT_GITHUB_TOKEN in .env, or run: npm run login");
  try {
    cachedCopilot = await getCopilotToken(ghToken);
  } catch (err) {
    cachedCopilot = null;
    throw err;
  }
  return cachedCopilot;
}

// Health check
app.get("/health", async (_req, res) => {
  const ghToken = getGitHubToken();
  res.json({ status: "ok", github_token_set: !!ghToken, copilot_ready: !!cachedCopilot });
});

// List models
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: Date.now(),
      owned_by: "github-copilot",
    })),
  });
});

// Chat completions
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { token, baseUrl } = await ensureCopilotToken();
    const { model, messages, stream, max_tokens, temperature } = req.body;

    const modelDef = MODELS.find((m) => m.id === model) || MODELS[0];

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const id = `chatcmpl-${Date.now()}`;

      await streamChat({
        copilotToken: token,
        baseUrl,
        model: modelDef.id,
        messages,
        maxTokens: max_tokens || modelDef.maxTokens,
        temperature,
        onStart: () => {
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelDef.id,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        onText: (text) => {
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelDef.id,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        onDone: (usage) => {
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelDef.id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: usage
              ? {
                  prompt_tokens: usage.input_tokens || 0,
                  completion_tokens: usage.output_tokens || 0,
                  total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                }
              : undefined,
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        },
        onError: (err) => {
          console.error("Stream error:", err.message);
          res.write("data: [DONE]\n\n");
          res.end();
        },
      });
    } else {
      const result = await streamChat({
        copilotToken: token,
        baseUrl,
        model: modelDef.id,
        messages,
        maxTokens: max_tokens || modelDef.maxTokens,
        temperature,
        collect: true,
      });

      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelDef.id,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.text },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: result.usage?.input_tokens || 0,
          completion_tokens: result.usage?.output_tokens || 0,
          total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
        },
      });
    }
  } catch (err) {
    console.error("Error:", err.message);
    const status = err.message.includes("No GitHub token") ? 401 : 500;
    res.status(status).json({ error: { message: err.message } });
  }
});

app.listen(PORT, HOST, () => {
  const ghToken = getGitHubToken();
  console.log(`Copilot Proxy running at http://${HOST}:${PORT}`);
  console.log(`GitHub token: ${ghToken ? ghToken.slice(0, 12) + "..." : "(not set)"}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions`);
  if (!ghToken) {
    console.log(`\nNo GitHub token found. Run: npm run login`);
  }
});
