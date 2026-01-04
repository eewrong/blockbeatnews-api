require('dotenv').config();
const Parser = require('rss-parser');
const pg = require('pg');

const parser = new Parser();
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        const { rows: sources } = await client.query(
            `SELECT id, name, rss_url FROM sources WHERE rss_url IS NOT NULL`
        );

        console.log(`Sources to ingest: ${sources.length}`);

        for (const source of sources) {
            console.log(`Ingesting ${source.name}`);
            const feed = await parser.parseURL(source.rss_url);

            for (const item of feed.items) {
                if (!item.link || !item.title) continue;

                await client.query(
                    `
          INSERT INTO articles (source_id, title, canonical_url, published_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (canonical_url) DO NOTHING
          `,
                    [
                        source.id,
                        item.title.trim(),
                        item.link.trim(),
                        item.pubDate ? new Date(item.pubDate) : null
                    ]
                );
            }
        }

        console.log('Ingestion complete');
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
