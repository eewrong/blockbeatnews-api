const express = require("express");
const cors = require("cors");
const pg = require("pg");
require("dotenv").config();

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

const PORT = process.env.PORT || 10000;

// Neon Postgres pool
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

app.get("/v1/articles", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
        const category = req.query.category;

        if (category) {
            const { rows } = await pool.query(
                `
        SELECT
          a.id,
          a.title,
          a.canonical_url,
          a.published_at,
          a.created_at,
          s.name AS source_name
        FROM articles a
        JOIN sources s ON s.id = a.source_id
        JOIN categories c ON c.id = s.category_id
        WHERE c.slug = $1
        ORDER BY COALESCE(a.published_at, a.created_at) DESC
        LIMIT $2
        `,
                [category, limit]
            );
            return res.json({ ok: true, items: rows });
        }

        const { rows } = await pool.query(
            `
      SELECT
        a.id,
        a.title,
        a.canonical_url,
        a.published_at,
        a.created_at,
        s.name AS source_name
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
      LIMIT $1
      `,
            [limit]
        );

        return res.json({ ok: true, items: rows });
    } catch (err) {
        console.error("GET /v1/articles failed", err);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});

// Optional: category alias endpoint (matches your frontend expectation if it calls /v1/articles?category=markets)
app.get("/v1/articles/by-category/:slug", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
        const slug = req.params.slug;

        const { rows } = await pool.query(
            `
      SELECT
        a.id,
        a.title,
        a.canonical_url,
        a.published_at,
        a.created_at,
        s.name AS source_name
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      JOIN categories c ON c.id = s.category_id
      WHERE c.slug = $1
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
      LIMIT $2
      `,
            [slug, limit]
        );

        return res.json({ ok: true, items: rows });
    } catch (err) {
        console.error("GET /v1/articles/by-category failed", err);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on ${PORT}`);
});
