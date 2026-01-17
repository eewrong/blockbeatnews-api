const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateAISummary({ title, content, url }) {


  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const body = (content && String(content).trim()) ? String(content).trim() : "";

  const input =
    `Create:\n` +
    `1) A rewritten news headline (max 14 words).\n` +
    `2) A neutral summary of about 50 words.\n\n` +
    `Rules:\n` +
    `- Use only facts present in the provided text.\n` +
    `- If details are limited, write a high-level summary of what the article covers and do not invent specifics.\n` +
    `- No hype, no opinion, no prediction.\n` +
    `- No quotes.\n` +
    `- British English spelling.\n` +
    `- Output valid JSON only with keys: headline, summary.\n\n` +
    `Title: ${title}\n` +
    `URL: ${url}\n\n` +
    `Text:\n${body ? body.slice(0, 6000) : "(No article text provided. Base this only on the title.)"}\n`;

  try {
    const response = await client.responses.create({
      model,
      input,
    });

        let out = response.output_text || "";

    // Remove ```json ... ``` or ``` ... ```
    out = out.replace(/```json\s*/gi, "```");
    out = out.replace(/```/g, "");
    out = out.trim();

    if (!out) return null;

    const parsed = JSON.parse(out);

    const ai_headline = parsed.headline ? String(parsed.headline).trim() : null;
    const ai_summary = parsed.summary ? String(parsed.summary).trim() : null;

    return { ai_headline, ai_summary };
  } catch (err) {
    console.log("AI summary failed:", err && err.message ? err.message : String(err));
    return null;
  }
}

module.exports = { generateAISummary };
