// scripts/backfill-images-financefeeds.js
try {
  require("dotenv").config();
} catch (e) {}

const pg = require("pg");

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOgImage(pageUrl) {
  try {
    await sleep(120);

    const res = await fetch(pageUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; BlockbeatNewsBot/1.0; +https://blockbeatnews.com)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();

    const patterns = [
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,

      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,

      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,

      /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image:src["']/i,
    ];

    let img = null;
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        img = m[1].trim();
        break;
      }
    }
    if (!img) return null;

    try {
      return new URL(img, pageUrl).toString();
    } catch {
      return img;
    }
  } catch {
    return null;
  }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();

  // FinanceFeeds source id
  const sourceId = intEnv("SOURCE_ID", 91);

  // Defaults: keep it safe
  const days = Math.max(1, intEnv("DAYS", 14));
  const limit = Math.max(1, intEnv("LIMIT", 80));
  const delayMs = Math.max(0, intEnv("DELAY_MS", 250));

  try {
    const { rows } = await client.query(
      `
      SELECT id, canonical_url
      FROM articles
      WHERE source_id = $1
        AND (image_url IS NULL OR image_url = '')
        AND COALESCE(published_at, created_at) >= NOW() - ($2 * INTERVAL '1 day')
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT $3
      `,
      [sourceId, days, limit]
    );

    console.log(
      `[img-backfill] source_id=${sourceId} | days=${days} | candidates=${rows.length}`
    );

    let updated = 0;

    for (const r of rows) {
      const url = (r.canonical_url || "").trim();
      if (!url) continue;

      const og = await fetchOgImage(url);

      if (og && og.trim()) {
        await client.query(
          `
          UPDATE articles
          SET image_url = $1
          WHERE id = $2
          `,
          [og.trim(), r.id]
        );
        updated++;
        console.log(`[img-backfill] updated article ${r.id}`);
      } else {
        console.log(`[img-backfill] no image for article ${r.id}`);
      }

      if (delayMs) await sleep(delayMs);
    }

    console.log(`[img-backfill] complete | updated=${updated}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
