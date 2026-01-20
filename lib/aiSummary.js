// C:\Users\chris\projects\blockbeatnews-api\lib\aiSummary.js
// Robust GA/cron-safe AI summariser: strict JSON request + defensive JSON extraction/parsing + 429 throttle/retry

const OpenAI = require("openai");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripCodeFences(s) {
  return String(s || "")
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractFirstJsonObject(text) {
  const s = stripCodeFences(text);

  // Fast path
  try {
    return JSON.parse(s);
  } catch {}

  // Try to find first {...} block
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      const candidate = s.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function normaliseAiPayload(obj) {
  if (!obj || typeof obj !== "object") return null;

  const ai_headline =
    typeof obj.ai_headline === "string" ? obj.ai_headline.trim() : "";
  const ai_summary =
    typeof obj.ai_summary === "string" ? obj.ai_summary.trim() : "";

  if (!ai_headline && !ai_summary) return null;

  return {
    ai_headline: ai_headline || null,
    ai_summary: ai_summary || null,
  };
}

async function generateAISummary({ title, url, content }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[ai] OPENAI_API_KEY missing, skipping AI summary");
    return null;
  }

  const client = new OpenAI({ apiKey });

  const safeTitle = String(title || "").slice(0, 220);
  const safeUrl = String(url || "").slice(0, 500);
  const safeContent = String(content || "").slice(0, 4000);

  const system = [
    "You are a careful news editor.",
    "Return STRICT JSON only. No markdown. No commentary.",
    'Schema: {"ai_headline":"...","ai_summary":"..."}',
    "ai_headline: max 90 chars, factual, no clickbait.",
    "ai_summary: max 50 words, factual, no hype, no emojis.",
    "Use UK British English spelling, grammar, and punctuation throughout.",
  ].join(" ");

  const user = [
    `TITLE: ${safeTitle}`,
    `URL: ${safeUrl}`,
    `CONTENT: ${safeContent}`,
  ].join("\n");

  let attempt = 0;

  while (attempt < 6) {
    // Throttle to reduce RPM bursts
    await sleep(150);

    try {
      const resp = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      });

      const raw = resp?.choices?.[0]?.message?.content || "";
      const parsed = extractFirstJsonObject(raw);
      const out = normaliseAiPayload(parsed);

      if (!out) {
        console.log("[ai] JSON parse failed or empty payload, skipping");
        return null;
      }

      return out;
    } catch (e) {
      const status = e?.status || e?.response?.status;

      if (status === 429) {
        attempt += 1;
        const backoffMs = 1000 * attempt; // 1s..6s
        console.log(`[ai] 429 rate limit, retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }

      console.log("[ai] AI summary failed:", e.message);
      return null;
    }
  }

  console.log("[ai] AI summary failed: too many 429 retries");
  return null;
}

module.exports = { generateAISummary };

