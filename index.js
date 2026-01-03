const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({
    origin: "http://localhost:3000"
}));

app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

app.get("/v1/articles", (req, res) => {
    res.json({
        ok: true,
        items: [
            {
                id: "placeholder-1",
                title: "Placeholder article",
                created_at: new Date().toISOString()
            }
        ]
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on ${PORT}`);
});
