// anthropicClient.ts
// ---------------------------------------------------------------------------
// Shared Anthropic client with PROMPT CACHING baked in.
//
// Import this everywhere instead of calling the SDK directly. Every app that
// uses it automatically gets:
//   - prompt caching on your (big, static) system prompt + tools
//   - an explicit 1-hour cache lifetime (dodges the silent 5-min default)
//   - a console log so you can SEE whether the cache is actually working
//
// This is the "set it once, use it everywhere" piece. The only thing each app
// supplies is its own system prompt + messages.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

type CachedMessageOptions = {
  /** Your BIG STATIC system prompt — the instructions that don't change between calls. */
  system?: string;
  /** The conversation, e.g. [{ role: "user", content: "Score this candidate: ..." }] */
  messages: Anthropic.MessageParam[];
  /** Optional tool definitions. */
  tools?: Anthropic.Tool[];
  /** Defaults to Sonnet. Swap to "claude-opus-4-8" for heavier reasoning. */
  model?: string;
  /** Defaults to 1024. */
  maxTokens?: number;
  /** Cache lifetime. "1h" (default) is best for calls spaced more than 5 min apart. */
  ttl?: "1h" | "5m";
};

export async function cachedMessage({
  system,
  messages,
  tools,
  model = "claude-sonnet-4-6",
  maxTokens = 1024,
  ttl = "1h",
}: CachedMessageOptions) {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  if (tools && tools.length > 0) {
    request.tools = tools;
  }

  if (system) {
    // Tagging the system block caches EVERYTHING up to and including it
    // (tools + system). That static prefix is what gets reused on later calls.
    request.system = [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral", ttl },
      },
    ];
  } else if (tools && tools.length > 0) {
    // No system prompt? Put the cache marker on the last tool instead.
    const toolsCopy = tools.map((t) => ({ ...t }));
    (toolsCopy[toolsCopy.length - 1] as any).cache_control = {
      type: "ephemeral",
      ttl,
    };
    request.tools = toolsCopy;
  }

  const response = await client.messages.create(request);

  // Prints whether the cache fired. On the 2nd+ call with the SAME system
  // prompt, "read" should be > 0. If it stays 0, the prompt is changing
  // between calls or is too small to cache (needs ~1024+ tokens).
  const u = response.usage;
  console.log(
    `[cache] wrote ${u.cache_creation_input_tokens ?? 0} | ` +
      `read ${u.cache_read_input_tokens ?? 0} | ` +
      `fresh input ${u.input_tokens ?? 0}`
  );

  return response;
}
