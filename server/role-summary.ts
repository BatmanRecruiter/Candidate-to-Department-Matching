import { cachedMessage } from "./anthropicClient";

// Summaries are generated ONCE per role and persisted (synced_roles.summary /
// shared/role-summaries.json). They must never be regenerated at match time —
// the matching system prompt embeds them, and a byte-stable prompt is what
// keeps the 1h prompt cache warm between calls.
const SUMMARY_MODEL = "claude-haiku-4-5";
const MAX_BODY_CHARS = 6000;

// Keep summaries SHORT: every one of them rides inside the matching prompt
// for every candidate, so each extra word here is paid per candidate scored.
const SUMMARY_SYSTEM = `You compress job postings for an internal recruiting tool. Given one posting, reply with ONE telegraphic line of AT MOST 20 words covering: core function, required years of experience, and the 3-5 most important skills. Example format: "Builds Snowflake/Databricks pipelines for enterprise clients; 5+ yrs; Python, SQL, AWS." No preamble, no markdown — output only the line.`;

export async function summarizeRole(
  title: string,
  department: string,
  body: string,
): Promise<string> {
  const resp = await cachedMessage({
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Department: ${department}\nTitle: ${title}\n\n${body.slice(0, MAX_BODY_CHARS)}`,
      },
    ],
    model: SUMMARY_MODEL,
    maxTokens: 60,
  });
  const textBlock = resp.content.find((b: { type: string }) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const text = textBlock?.text?.trim();
  if (!text) throw new Error("summary response contained no text");
  return text;
}
