const express = require('express');
const { scrapeInmate } = require('./scraper');

const app = express();

// ✅ REQUIRED for Postman / n8n JSON
app.use(express.json());

// ✅ Health check route (VERY useful)
app.get('/', (req, res) => {
  res.send('Playwright Scraper API is running');
});

// 🔁 Retry helper (handles flaky scraping / proxy issues)
async function retry(fn, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempt ${i + 1}`);
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`Retry ${i + 1} failed:`, err.message);
    }
  }

  throw lastError;
}

// 🎯 MAIN SCRAPE ENDPOINT
app.post('/scrape', async (req, res) => {
  console.log('Incoming request:', req.body);

  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Name is required'
      });
    }

    // 🔁 Run scraper with retries
    const data = await retry(() => scrapeInmate(name), 3);

    return res.json({
      success: true,
      found: !!data,
      data: data || null
    });

  } catch (err) {
    console.error('FINAL ERROR:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ✅ VERY IMPORTANT FOR RAILWAY
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
