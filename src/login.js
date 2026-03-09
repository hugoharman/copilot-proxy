import { deviceCodeLogin, getCopilotToken, enableModel } from "./copilot-auth.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

async function main() {
  console.log("=== GitHub Copilot Login ===\n");
  console.log("This will authenticate via GitHub device code flow.\n");

  const githubToken = await deviceCodeLogin();
  console.log("\nGitHub token obtained!");

  // Exchange for Copilot token to verify it works
  console.log("Exchanging for Copilot token...");
  const { token, baseUrl } = await getCopilotToken(githubToken);
  console.log(`Copilot API: ${baseUrl}`);

  // Enable Claude models
  console.log("Enabling Claude models...");
  for (const modelId of ["claude-opus-4.6", "claude-sonnet-4.5", "claude-haiku-4.5"]) {
    await enableModel(baseUrl, token, modelId);
  }
  console.log("Models enabled!");

  // Save to .env
  const envContent = `GITHUB_TOKEN=${githubToken}\n`;
  fs.writeFileSync(envPath, envContent);
  console.log(`\nSaved to .env`);
  console.log("Run: npm start");
}

main().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
