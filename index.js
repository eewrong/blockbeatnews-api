const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: "http://localhost:3000"
}));

app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${PORT}`);
});

