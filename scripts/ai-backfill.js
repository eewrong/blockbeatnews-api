// scripts/ai-backfill.js
try {
  require("dotenv").config();
} catch (e) {}

const pg = require("pg");
const { generateAISummary } = require("../lib/aiSummary.js");

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();

  // Defaults chosen to be safe on Render cron
  const limit = Math.max(1, intEnv("AI_BACKFILL_LIMIT", 25));
  const delayMs = Math.max(0, intEnv("AI_BACKFILL_DELAY_MS", 800));

  try {
    const { rows: items } = await client.query(
      `
      SELECT id, title, canonical_url, ai_summary
      FROM articles
      WHERE (ai_summary IS NULL OR ai_summary = '')
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT $1
      `,
      [limit]
    );

    console.log(`[ai-backfill] candidates: ${items.length}`);

    for (const a of items) {
      const title = (a.title || "").trim();
      const url = (a.canonical_url || "").trim();
      if (!title || !url) continue;

      try {
        const ai = await generateAISummary({
          title,
          url,
          content: "", // keep lightweight; the model can summarise from URL context if your lib supports it
        });

        if (ai && ai.ai_headline && ai.ai_summary) {
          await client.query(
            `
            UPDATE articles
            SET ai_headline = $1,
                ai_summary  = $2
            WHERE id = $3
            `,
            [ai.ai_headline, ai.ai_summary, a.id]
          );

          console.log(`[ai-backfill] updated article ${a.id}`);
        } else {
          console.log(`[ai-backfill] no ai result for article ${a.id}`);
        }
      } catch (e) {
        console.log(`[ai-backfill] failed article ${a.id}: ${e.message}`);
      }

      if (delayMs) await sleep(delayMs);
    }

    console.log("[ai-backfill] complete");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
