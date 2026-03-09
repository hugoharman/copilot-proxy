import Anthropic from "@anthropic-ai/sdk";
import { COPILOT_HEADERS } from "./copilot-auth.js";

/**
 * Create an Anthropic client configured for GitHub Copilot.
 *
 * From OpenClaw (pi-ai/providers/anthropic.js):
 * - Copilot uses Bearer auth (authToken, not apiKey)
 * - Beta: interleaved-thinking (but NOT fine-grained-tool-streaming)
 * - Includes Copilot-specific static headers on the model
 */
function createClient(copilotToken, baseUrl) {
  return new Anthropic({
    apiKey: null,
    authToken: copilotToken,
    baseURL: baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      ...COPILOT_HEADERS,
    },
  });
}

/**
 * Convert OpenAI-style messages to Anthropic format.
 */
function convertMessages(messages) {
  const systemParts = [];
  const converted = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user") {
      converted.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      converted.push({ role: "assistant", content: msg.content });
    }
  }

  return { systemParts, converted };
}

/**
 * Infer X-Initiator header from messages (from OpenClaw copilot-headers.js)
 */
function inferInitiator(messages) {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

/**
 * Stream a chat completion via the Copilot Anthropic endpoint.
 */
export async function streamChat({
  copilotToken,
  baseUrl,
  model,
  messages,
  maxTokens = 8192,
  temperature,
  collect = false,
  onStart,
  onText,
  onDone,
  onError,
}) {
  const client = createClient(copilotToken, baseUrl);
  const { systemParts, converted } = convertMessages(messages);

  const system = systemParts.length > 0
    ? systemParts.map((t) => ({ type: "text", text: t }))
    : undefined;

  const params = {
    model,
    messages: converted,
    max_tokens: maxTokens,
    stream: true,
  };

  if (system) params.system = system;
  if (temperature !== undefined) params.temperature = temperature;

  // Copilot dynamic headers
  const dynamicHeaders = {
    "X-Initiator": inferInitiator(messages),
    "Openai-Intent": "conversation-edits",
  };

  if (collect) {
    let fullText = "";
    let finalUsage = null;

    const stream = client.messages.stream(params, { headers: dynamicHeaders });

    for await (const event of stream) {
      if (event.type === "message_start") {
        finalUsage = event.message.usage;
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          fullText += event.delta.text;
        }
      } else if (event.type === "message_delta") {
        if (event.usage) finalUsage = { ...finalUsage, ...event.usage };
      }
    }

    return { text: fullText, usage: finalUsage };
  }

  // Streaming mode
  try {
    const stream = client.messages.stream(params, { headers: dynamicHeaders });
    onStart?.();

    let finalUsage = null;

    for await (const event of stream) {
      if (event.type === "message_start") {
        finalUsage = event.message.usage;
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          onText?.(event.delta.text);
        }
      } else if (event.type === "message_delta") {
        if (event.usage) finalUsage = { ...finalUsage, ...event.usage };
      }
    }

    onDone?.(finalUsage);
  } catch (err) {
    onError?.(err);
    if (!onError) throw err;
  }
}
