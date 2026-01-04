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

        // Frontend slug -> DB slug
        const slugMap = {
            "market-news": "markets",
            "nft-news": "nfts",
            "crypto-currents": "altcoins",
            "defi-and-dapps": "defi",
            "regulation-policy": "regulation",
            "ai-insights": "ai-crypto",
            "web3": "builders",
            "blockchain": "builders",
        };

        const resolvedCategory = category ? (slugMap[category] || category) : null;

        if (resolvedCategory) {
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
                [resolvedCategory, limit]
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

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on ${PORT}`);
});
