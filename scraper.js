const { chromium } = require('playwright');

const PROXIES = [
  {
    server: 'http://31.59.20.176:6754',
    username: 'tznskjmn',
    password: 'ag3c9yyj3w0l'
  }
  // 👉 add more proxies here for rotation
];

function getRandomProxy() {
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

async function scrapeInmate(name) {
  const proxy = getRandomProxy();

  const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

  const context = await browser.newContext({
    proxy,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // 1. Open search page
    await page.goto('http://inmate-search.cobbsheriff.org/enter_name.htm', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // 2. Fill name
    await page.fill('input[name="inmate_name"]', name);

    // 3. Submit form
    await Promise.all([
      page.waitForNavigation({ timeout: 60000 }),
      page.click('input[value="Search"]')
    ]);

    // 4. Check results
    const rows = await page.$$('table tr');
    if (rows.length < 2) {
      await browser.close();
      return null;
    }

    // 5. Extract first row
    const basic = await page.evaluate(() => {
      const row = document.querySelectorAll('table tr')[1];
      const cells = row.querySelectorAll('td');

      return {
        name: cells[1]?.innerText.trim(),
        dob: cells[2]?.innerText.trim(),
        race: cells[3]?.innerText.trim(),
        sex: cells[4]?.innerText.trim(),
        location: cells[5]?.innerText.trim(),
        soid: cells[6]?.innerText.trim()
      };
    });

    // 6. Click booking
    await Promise.all([
      page.waitForNavigation({ timeout: 60000 }),
      page.click('input[value="Last Known Booking"]')
    ]);

    // 7. Extract details
    const details = await page.evaluate(() => {
      const getValue = (label) => {
        const cell = Array.from(document.querySelectorAll('td'))
          .find(td => td.innerText.trim() === label);
        return cell?.nextElementSibling?.innerText.trim() || null;
      };

      return {
        agency_id: getValue('Agency ID'),
        arrest_date: getValue('Arrest Date/Time'),
        booking_started: getValue('Booking Started'),
        booking_complete: getValue('Booking Complete'),
        height: getValue('Height'),
        weight: getValue('Weight'),
        hair: getValue('Hair'),
        eyes: getValue('Eyes'),
        address: getValue('Address'),
        place_of_birth: getValue('Place of Birth')
      };
    });

    await browser.close();

    return {
      ...basic,
      ...details
    };

  } catch (err) {
    await browser.close();
    throw err;
  }
}

module.exports = { scrapeInmate };
