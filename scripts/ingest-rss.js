// scripts/ingest-rss.js
// Load .env locally if present. Render provides env vars directly.
try {
  require("dotenv").config();
} catch (e) {}

const Parser = require("rss-parser");
const pg = require("pg");

const { generateAISummary } = require("../lib/aiSummary.js");

async function fetchOgImage(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;

    const html = await res.text();

    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function pickImageUrl(item) {
  const enc = item?.enclosure;
  if (enc && typeof enc.url === "string" && enc.url.trim()) return enc.url.trim();

  const mediaContent = item?.["media:content"];
  if (Array.isArray(mediaContent)) {
    for (const m of mediaContent) {
      const url = m?.$?.url || m?.url;
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  } else if (mediaContent) {
    const url = mediaContent?.$?.url || mediaContent?.url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }

  const mediaThumb = item?.["media:thumbnail"];
  if (Array.isArray(mediaThumb)) {
    for (const t of mediaThumb) {
      const url = t?.$?.url || t?.url;
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  } else if (mediaThumb) {
    const url = mediaThumb?.$?.url || mediaThumb?.url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }

  const itunesImg = item?.["itunes:image"]?.href || item?.["itunes:image"]?.url;
  if (typeof itunesImg === "string" && itunesImg.trim()) return itunesImg.trim();

  const imageField = item?.image?.url || item?.image;
  if (typeof imageField === "string" && imageField.trim()) return imageField.trim();
  if (
    typeof imageField === "object" &&
    typeof imageField.url === "string" &&
    imageField.url.trim()
  ) {
    return imageField.url.trim();
  }

  // AMBCrypto fallback: try og:image from article page
  const link = item?.link || item?.guid;
  if (typeof link === "string" && link.includes("ambcrypto.com")) {
    const og = await fetchOgImage(link);
    if (typeof og === "string" && og.trim()) return og.trim();
  }

  return null;
}


function canonicaliseUrl(raw) {
  try {
    const u = new URL(raw.trim());
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) =>
      u.searchParams.delete(k)
    );
    return u.toString();
  } catch {
    return raw.trim();
  }
}

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; BlockbeatNewsBot/1.0; +https://blockbeatnews.com)",
    Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  },
});

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

async function run() {
  const client = await pool.connect();

  // Sharding: split sources across multiple cron jobs to avoid Render timeouts
  const shards = Math.max(1, intEnv("INGEST_SHARDS", 2));
  const shard = Math.min(Math.max(0, intEnv("INGEST_SHARD", 0)), shards - 1);

  try {
    const { rows: sources } = await client.query(
      `
        SELECT id, name, rss_url
        FROM sources
        WHERE rss_url IS NOT NULL
          AND (id % $1) = $2
        ORDER BY id
      `,
      [shards, shard]
    );

    console.log(`Ingest shard ${shard}/${shards} | Sources to ingest: ${sources.length}`);

    for (const source of sources) {
      console.log(`Ingesting ${source.name}`);

      let feed;
      try {
        feed = await parser.parseURL(source.rss_url);
      } catch (err) {
        console.log(`Skipping ${source.name}: ${err.message}`);
        continue;
      }

      for (const item of feed.items) {
        if (!item.link || !item.title) continue;

        const imageUrl = await pickImageUrl(item);
        const cleanUrl = canonicaliseUrl(item.link);

        const { rows } = await client.query(
          `
          INSERT INTO articles (source_id, title, canonical_url, published_at, image_url)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (canonical_url) DO UPDATE
          SET image_url = COALESCE(EXCLUDED.image_url, articles.image_url)
          RETURNING id, (xmax = 0) AS inserted
          `,
          [
            source.id,
            item.title.trim(),
            cleanUrl,
            item.pubDate ? new Date(item.pubDate) : null,
            imageUrl,
          ]
        );

        const articleId = rows[0]?.id;
        const inserted = rows[0]?.inserted;

        // Only run AI for newly inserted items
        if (articleId && inserted) {
          try {
            const ai = await generateAISummary({
              title: item.title.trim(),
              url: cleanUrl,
              content:
                item.content ||
                item["content:encoded"] ||
                item.contentSnippet ||
                item.summary ||
                item.description ||
                "",
            });

            if (ai) {
              await client.query(
                `UPDATE articles
                 SET ai_headline = $1,
                     ai_summary  = $2
                 WHERE id = $3`,
                [ai.ai_headline, ai.ai_summary, articleId]
              );
            }
          } catch (e) {
            console.log("AI update failed:", e.message);
          }
        }
      }
    }

    console.log("Ingestion complete");

    // Run retention once (shard 0 only) so you do not double-delete / double-work
    if (shard === 0) {
      const retentionDays = Math.max(1, intEnv("RETENTION_DAYS", 20));

      const retentionResult = await client.query(
        `
          DELETE FROM articles
          WHERE COALESCE(published_at, created_at) < NOW() - ($1 * INTERVAL '1 day')
        `,
        [retentionDays]
      );

      console.log(
        `[retention] deleted ${retentionResult.rowCount} articles older than ${retentionDays} days`
      );
    } else {
      console.log("[retention] skipped (only runs on shard 0)");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
