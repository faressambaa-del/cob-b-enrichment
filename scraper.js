const { chromium } = require("playwright");

async function scrapeInmate(name) {
  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: "http://31.59.20.176:6754",
      username: "tznskjmn",
      password: "ag3c9yyj3w0l"
    }
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US"
  });

  const page = await context.newPage();

  try {
    console.log("Setting headers...");

    // ✅ ADD THIS BEFORE GOTO (as requested)
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "DNT": "1"
    });

    console.log("Navigating...");

    // ✅ MAX PRACTICAL TIMEOUT (Playwright supports up to ~2147483647 but not realistic)
    const response = await page.goto(
      "https://inmate-search.cobbsheriff.org/enter_name.htm",
      {
        waitUntil: "load",
        timeout: 180000 // 🔥 3 minutes (very high but stable)
      }
    );

    console.log("Status:", response?.status());

    // Optional: remove timeout limits entirely for actions
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);

    // Fill form safely
    const [last, first] = name.split(" ");

    await page.fill('input[name="lastName"]', last || "");
    await page.fill('input[name="firstName"]', first || "");

    console.log("Submitting form...");

    await Promise.all([
      page.waitForNavigation({
        timeout: 180000,
        waitUntil: "load"
      }),
      page.click('input[type="submit"]')
    ]);

    console.log("Waiting for results...");

    await page.waitForTimeout(5000);

    const content = await page.content();

    return {
      success: true,
      html: content.slice(0, 5000)
    };

  } catch (err) {
    console.error("SCRAPER ERROR:", err);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInmate };
