const express = require("express");
const cors = require("cors");
const pg = require("pg");
require("dotenv").config();
const redis = require("./lib/redis");
const rateLimit = require("express-rate-limit");


const app = express();

// CORS: allow Vercel + local dev
app.use(
    cors({
        origin: [
            "http://localhost:3000",
            "https://blockbeatnews.com",
            "https://www.blockbeatnews.com",
            "https://blockbeatnews.vercel.app",
        ],
        methods: ["GET", "POST", "OPTIONS"],
    })
);

app.use(express.json());
const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});


const PORT = process.env.PORT || 10000;

// Neon Postgres pool
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function cacheGet(key) {
    if (!redis) return null;
    try {
        const value = await redis.get(key);
        if (!value) return null;

        if (typeof value === "string") {
            try {
                return JSON.parse(value);
            } catch (e) {
                return null;
            }
        }

        return value;
    } catch (err) {
        return null;
    }
}


async function cacheSet(key, value, ttlSeconds) {
    if (!redis) return;
    try {
        await redis.set(key, value, { ex: ttlSeconds });
    } catch (err) {
        // fail open
    }
}

app.get("/health", async (req, res) => {
    let redisStatus = "disabled";

    if (redis) {
        try {
            await redis.ping();
            redisStatus = "ok";
        } catch (err) {
            redisStatus = "error";
        }
    }

    res.json({ ok: true, redis: redisStatus });
});


app.get("/v1/articles", publicLimiter, async (req, res) => {    const cacheKey = `articles:${req.query.category || "all"}:${req.query.limit || "50"}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
        return res.json(cached);
    }


    try {
        const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
        const category = req.query.category;

        // Frontend slug -> DB slug
        const resolvedCategory = category || null;

        if (resolvedCategory) {
            const { rows } = await pool.query(
                `
        SELECT
          a.id,
          a.title,
          a.canonical_url,
          a.published_at,
          a.created_at,
          s.name AS source_name,
          a.image_url,
          a.ai_headline,
          a.ai_summary


        FROM articles a
        JOIN sources s ON s.id = a.source_id
        JOIN categories c ON c.id = s.category_id
        WHERE c.slug = $1
        ORDER BY COALESCE(a.published_at, a.created_at) DESC
        LIMIT $2
        `,
                [resolvedCategory, limit]
            );
                        const response = { ok: true, items: rows };
            await cacheSet(cacheKey, response, 30);
            return res.json(response);

        }

        const { rows } = await pool.query(
            `
      SELECT
        a.id,
        a.title,
        a.canonical_url,
        a.published_at,
        a.created_at,
        s.name AS source_name,
        a.image_url,
        a.ai_headline,
        a.ai_summary


      FROM articles a
      JOIN sources s ON s.id = a.source_id
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
      LIMIT $1
      `,
            [limit]
        );

                    const response = { ok: true, items: rows };
            await cacheSet(cacheKey, response, 30);
            return res.json(response);

    } catch (err) {
        console.error("GET /v1/articles failed", err);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on ${PORT}`);
});
