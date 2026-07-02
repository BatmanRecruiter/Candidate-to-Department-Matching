import { cachedMessage } from "./anthropicClient";

// Summaries are generated ONCE per role and persisted (synced_roles.summary /
// shared/role-summaries.json). They must never be regenerated at match time —
// the matching system prompt embeds them, and a byte-stable prompt is what
// keeps the 1h prompt cache warm between calls.
const SUMMARY_MODEL = "claude-haiku-4-5";
const MAX_BODY_CHARS = 6000;

const SUMMARY_SYSTEM = `You summarize job postings for an internal recruiting tool. Given one posting, reply with 1-2 plain-text sentences: first the core responsibilities of the role, then the key qualifications (years of experience, must-have skills, seniority level). No preamble, no markdown, no quotes — output only the sentences.`;

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
    maxTokens: 250,
  });
  const textBlock = resp.content.find((b: { type: string }) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const text = textBlock?.text?.trim();
  if (!text) throw new Error("summary response contained no text");
  return text;
}
