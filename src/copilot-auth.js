import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = path.join(__dirname, "..", ".copilot-token.json");

// GitHub Copilot OAuth client ID (from OpenClaw source)
const CLIENT_ID = "Iv1.b507a08c87ecfe98";

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/**
 * Get GitHub access token from env vars (priority order from OpenClaw)
 */
export function getGitHubToken() {
  return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

/**
 * Exchange GitHub token for a Copilot API token.
 * Calls: GET https://api.github.com/copilot_internal/v2/token
 */
async function fetchCopilotToken(githubToken) {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to get Copilot token (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    token: data.token,
    expiresAt: data.expires_at,
  };
}

/**
 * Extract API base URL from Copilot token.
 * Token contains proxy-ep=proxy.individual.githubcopilot.com
 * Convert proxy.xxx -> api.xxx -> https://api.xxx
 */
export function extractBaseUrl(copilotToken) {
  const match = copilotToken.match(/proxy-ep=([^;]+)/);
  if (!match) return "https://api.individual.githubcopilot.com";
  const proxyEp = match[1].trim();
  const apiHost = proxyEp.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

/**
 * Load cached token if still valid (5 min buffer).
 */
function loadCachedToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, "utf8"));
    const expiresAt = data.expiresAt;
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt - now > 300) {
      return data;
    }
  } catch {}
  return null;
}

/**
 * Save token to cache file.
 */
function cacheToken(data) {
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(data, null, 2));
}

/**
 * Get a valid Copilot token, refreshing if needed.
 * Returns { token, baseUrl }
 */
export async function getCopilotToken(githubToken) {
  // Check cache first
  const cached = loadCachedToken();
  if (cached) {
    return {
      token: cached.token,
      baseUrl: extractBaseUrl(cached.token),
    };
  }

  // Fetch new token
  const data = await fetchCopilotToken(githubToken);
  cacheToken(data);

  return {
    token: data.token,
    baseUrl: extractBaseUrl(data.token),
  };
}

/**
 * Device code login flow — for users who don't have a GH token yet.
 */
export async function deviceCodeLogin() {
  // Step 1: Request device code
  const codeRes = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!codeRes.ok) throw new Error(`Device code request failed: ${codeRes.status}`);
  const { device_code, user_code, verification_uri, interval, expires_in } = await codeRes.json();

  console.log(`\nOpen this URL in your browser:\n  ${verification_uri}\n`);
  console.log(`Enter code: ${user_code}\n`);
  console.log("Waiting for authorization...");

  // Step 2: Poll for access token
  const deadline = Date.now() + expires_in * 1000;
  const pollInterval = (interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await tokenRes.json();

    if (data.access_token) {
      return data.access_token;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (data.error) throw new Error(`Auth error: ${data.error} - ${data.error_description}`);
  }

  throw new Error("Login timed out");
}

/**
 * Enable a model via Copilot policy API.
 */
export async function enableModel(baseUrl, copilotToken, modelId) {
  try {
    await fetch(`${baseUrl}/models/${modelId}/policy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        "Content-Type": "application/json",
        ...COPILOT_HEADERS,
        "openai-intent": "chat-policy",
        "x-interaction-type": "chat-policy",
      },
      body: JSON.stringify({ state: "enabled" }),
    });
  } catch {}
}

export { COPILOT_HEADERS };
