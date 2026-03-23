const express = require('express');
const { scrapeInmate } = require('./scraper');

const app = express();
app.use(express.json());

async function retry(fn, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.log(`Retry ${i + 1} failed`);
    }
  }
  throw lastError;
}

app.post('/scrape', async (req, res) => {
  try {
    const { name } = req.body;

    const data = await retry(() => scrapeInmate(name), 3);

    res.json({
      success: true,
      found: !!data,
      data
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
});
