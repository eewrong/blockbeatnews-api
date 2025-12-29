// index.js (CommonJS, Express)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const Redis = require("ioredis");
const Parser = require("rss-parser");
const { z } = require("zod");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Tighten later: set CORS to your Vercel domain(s) only
app.use(cors());

const PORT = process.env.PORT || 3000;
const VERSION = process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || "dev";

// Postgres
if (!process.env.DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
}
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

// Redis (optional)
let redis = null;
if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
    });
}

// RSS parser
const parser = new Parser({
    timeout: 10000,
    headers: { "User-Agent": "BlockbeatNewsBot/1.0 (+https://blockbeatnews.com)" },
});

// Configure feeds (start simple, expand later)
const FEEDS = [
    // Example placeholders: replace with your chosen sources
    // { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
    // { name: "The Block", url: "https://www.theblock.co/rss.xml" },
];

// Helpers
function requireAdminKey(req, res, next) {
    const key = req.header("x-admin-key");
    if (!process.env.ADMIN_INGEST_KEY) {
        return res.status(500).json({ ok: false, error: "ADMIN_INGEST_KEY not set" });
    }
    if (!key || key !== process.env.ADMIN_INGEST_KEY) {
        return res.status(401).json({ ok: false, error: "Unauthorised" });
    }
    next();
}

async function upsertSource(client, { name, url }) {
    const q = `
    insert into sources (name, url)
    values ($1, $2)
    on conflict (url) do update set name = excluded.name
    returning id, name, url
  `;
    const r = await client.query(q, [name, url]);
    return r.rows[0];
}

async function upsertArticle(client, article) {
    const q = `
    insert into articles (source_id, title, url, published_at, summary, content, image_url)
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (url) do update set
      title = excluded.title,
      published_at = excluded.published_at,
      summary = coalesce(excluded.summary, articles.summary),
      content = coalesce(excluded.content, articles.content),
      image_url = coalesce(excluded.image_url, articles.image_url)
    returning id
  `;
    const r = await client.query(q, [
        article.source_id,
        article.title,
        article.url,
        article.published_at,
        article.summary || null,
        article.content || null,
        article.image_url || null,
    ]);
    return r.rows[0];
}

function normaliseDate(d) {
    if (!d) return null;
    const dt = new Date(d);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function pickImage(item) {
    // Tries a few common RSS patterns
    if (item.enclosure && item.enclosure.url) return item.enclosure.url;
    if (item.image && item.image.url) return item.image.url;
    if (item.itunes && item.itunes.image) return item.itunes.image;
    return null;
}

// Routes
app.get("/health", async (req, res) => {
    // Basic dependency checks without hammering
    let dbOk = false;
    try {
        await pg.query("select 1 as ok");
        dbOk = true;
    } catch (e) { }

    let redisOk = null;
    if (redis) {
        try {
            const pong = await redis.ping();
            redisOk = pong === "PONG";
        } catch (e) {
            redisOk = false;
        }
    }

    res.json({
        ok: true,
        service: "blockbeatnews-api",
        version: VERSION,
        time: new Date().toISOString(),
        db: dbOk,
        redis: redisOk,
    });
});

app.get("/v1/news", async (req, res) => {
    const schema = z.object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().optional(), // ISO date cursor
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "Bad query params" });
    }
    const { limit, cursor } = parsed.data;

    const cacheKey = redis ? `news:v1:limit=${limit}:cursor=${cursor || ""}` : null;
    if (redis && cacheKey) {
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }
    }

    const params = [limit];
    let where = "";
    if (cursor) {
        where = "where a.published_at < $2";
        params.push(cursor);
    }

    const q = `
    select
      a.id,
      a.title,
      a.url,
      a.published_at,
      a.summary,
      a.image_url,
      s.name as source_name,
      s.url as source_url
    from articles a
    join sources s on s.id = a.source_id
    ${where}
    order by a.published_at desc nulls last, a.created_at desc
    limit $1
  `;

    const r = await pg.query(q, params);

    const items = r.rows.map((row) => ({
        id: row.id,
        title: row.title,
        url: row.url,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        summary: row.summary,
        imageUrl: row.image_url,
        source: {
            name: row.source_name,
            url: row.source_url,
        },
    }));

    const nextCursor = items.length ? items[items.length - 1].publishedAt : null;

    const payload = { ok: true, items, nextCursor };

    if (redis && cacheKey) {
        await redis.set(cacheKey, JSON.stringify(payload), "EX", 45);
    }

    res.json(payload);
});

app.get("/v1/news/:id", async (req, res) => {
    const id = req.params.id;

    const q = `
    select
      a.id,
      a.title,
      a.url,
      a.published_at,
      a.summary,
      a.content,
      a.image_url,
      s.name as source_name,
      s.url as source_url
    from articles a
    join sources s on s.id = a.source_id
    where a.id = $1
    limit 1
  `;

    const r = await pg.query(q, [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    const row = r.rows[0];
    res.json({
        ok: true,
        item: {
            id: row.id,
            title: row.title,
            url: row.url,
            publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
            summary: row.summary,
            content: row.content,
            imageUrl: row.image_url,
            source: { name: row.source_name, url: row.source_url },
        },
    });
});

app.post("/admin/ingest", requireAdminKey, async (req, res) => {
    if (!FEEDS.length) {
        return res.status(400).json({
            ok: false,
            error: "No feeds configured in FEEDS array in index.js",
        });
    }

    const maxItemsPerFeed = 50;

    const client = await pg.connect();
    let insertedOrUpdated = 0;
    let processed = 0;
    let feedErrors = [];

    try {
        await client.query("begin");

        for (const feed of FEEDS) {
            try {
                const source = await upsertSource(client, feed);

                const parsedFeed = await parser.parseURL(feed.url);
                const items = (parsedFeed.items || []).slice(0, maxItemsPerFeed);

                for (const item of items) {
                    const title = (item.title || "").trim();
                    const url = (item.link || "").trim();
                    if (!title || !url) continue;

                    const publishedAt = normaliseDate(item.isoDate || item.pubDate);
                    const summary = (item.contentSnippet || item.summary || "").trim() || null;
                    const content = (item["content:encoded"] || item.content || "").trim() || null;
                    const imageUrl = pickImage(item);

                    await upsertArticle(client, {
                        source_id: source.id,
                        title,
                        url,
                        published_at: publishedAt,
                        summary,
                        content,
                        image_url: imageUrl,
                    });

                    processed += 1;
                    insertedOrUpdated += 1;
                }
            } catch (e) {
                feedErrors.push({ feed: feed.url, error: e.message || String(e) });
            }
        }

        await client.query("commit");

        // Bust cache
        if (redis) {
            // crude approach for now: flush keys with prefix
            const keys = await redis.keys("news:v1:*");
            if (keys.length) await redis.del(keys);
        }

        res.json({
            ok: true,
            processed,
            upserts: insertedOrUpdated,
            feedErrors,
        });
    } catch (e) {
        await client.query("rollback");
        res.status(500).json({ ok: false, error: e.message || String(e) });
    } finally {
        client.release();
    }
});

app.listen(PORT, () => {
    console.log(`API listening on ${PORT}`);
});
