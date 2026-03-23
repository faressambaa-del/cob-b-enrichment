const express = require("express");
const { scrapeInmate } = require("./scraper");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

async function retry(fn, retries = 3) {
  let lastError;
  for (let i = 1; i <= retries; i++) {
    try {
      console.log(`Attempt ${i}`);
      return await fn();
    } catch (err) {
      console.error(`Retry ${i} failed:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

app.post("/scrape", async (req, res) => {
  const { name } = req.body;

  console.log("Incoming request:", req.body);

  try {
    const result = await retry(() => scrapeInmate(name), 3);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("FINAL ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
