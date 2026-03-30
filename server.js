'use strict';

const express      = require('express');
const { chromium } = require('playwright');

const app  = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PROXY_HOST = process.env.PROXY_HOST || '107.172.163.27';
const PROXY_PORT = process.env.PROXY_PORT || '6543';
const PROXY_USER = process.env.PROXY_USER || 'bhkcvqwz';
const PROXY_PASS = process.env.PROXY_PASS || '8o7dd3heu5b3';
const PROXY_URL  = PROXY_HOST
  ? `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`
  : null;

const BASE_URL = 'http://inmate-search.cobbsheriff.org';

async function launchBrowser() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  };
  if (PROXY_URL) {
    opts.proxy = { server: `http://${PROXY_HOST}:${PROXY_PORT}` };
  }
  return chromium.launch(opts);
}

async function newContext(browser) {
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
  if (PROXY_URL && PROXY_USER) {
    ctxOpts.httpCredentials = { username: PROXY_USER, password: PROXY_PASS };
  }
  return browser.newContext(ctxOpts);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatName(raw) {
  if (!raw) return '';
  raw = raw.trim().toUpperCase();
  if (raw.includes(',')) {
    const [last, rest] = raw.split(',');
    const first = (rest || '').trim().split(/\s+/)[0];
    return `${last.trim()} ${first}`.trim();
  }
  return raw;
}

async function scrapeInmate(searchName, soidVal) {
  const inquiryUrl = [
    BASE_URL + '/inquiry.asp',
    `?soid=${encodeURIComponent(soidVal || '')}`,
    `&inmate_name=${encodeURIComponent(searchName || '').replace(/%20/g, '+')}`,
    `&serial=`,
    `&qry=Inquiry`,
  ].join('');

  console.log(`[scrape] Navigating to: ${inquiryUrl}`);

  const browser = await launchBrowser();
  const context = await newContext(browser);
  const page    = await context.newPage();

  try {
    await page.goto(inquiryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);

    const pageText = await page.textContent('body').catch(() => '');

    if (/no record/i.test(pageText) || /not found/i.test(pageText) || /no match/i.test(pageText)) {
      console.log('[scrape] No record found');
      return { found: false, data: null };
    }

    // Intercept window.open to capture detail URL
    let capturedUrl = await page.evaluate(() => {
      return new Promise((resolve) => {
        window.open = (url) => {
          resolve(url);
          return null;
        };

        const buttons = Array.from(document.querySelectorAll('input[type="submit"], button, input[type="button"]'));
        const bookingBtn = buttons.find(b =>
          /last/i.test(b.value || b.innerText || '') ||
          /booking/i.test(b.value || b.innerText || '')
        );

        if (bookingBtn) {
          bookingBtn.click();
        } else {
          resolve(null);
        }

        setTimeout(() => resolve(null), 4000);
      });
    });

    console.log(`[scrape] Captured URL: ${capturedUrl}`);

    // Fallback: extract from raw HTML
    if (!capturedUrl) {
      const html = await page.content();
      const match = html.match(/InmDetails\.asp\?[^"'<>\s]+/);
      if (match) {
        capturedUrl = match[0].replace(/&amp;/g, '&');
        console.log(`[scrape] Extracted from HTML: ${capturedUrl}`);
      }
    }

    // Navigate to detail page
    if (capturedUrl) {
      const fullUrl = capturedUrl.startsWith('http')
        ? capturedUrl
        : BASE_URL + '/' + capturedUrl.replace(/^\//, '');
      console.log(`[scrape] Going to detail: ${fullUrl}`);
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
    } else {
      console.log('[scrape] No detail URL — parsing current page');
    }

    console.log(`[scrape] Final URL: ${page.url()}`);

    const allRows = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('table').forEach(tbl => {
        tbl.querySelectorAll('tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('td, th'))
            .map(td => (td.innerText || '').trim());
          if (cells.some(c => c.length > 0)) rows.push(cells);
        });
      });
      return rows;
    });

    const fullText = await page.evaluate(() => document.body.innerText || '');
    console.log(`[scrape] ✅ Scraped ${allRows.length} rows`);

    const data = parseRows(allRows, fullText, searchName || soidVal);

    return {
      found:      true,
      detail_url: page.url(),
      scraped_at: new Date().toISOString(),
      data,
    };

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function parseRows(allRows, fullText, originalName) {
  const txt = (fullText || '').toLowerCase();

  function findVal(label) {
    const l = label.toLowerCase();
    for (let i = 0; i < allRows.length; i++) {
      for (let j = 0; j < allRows[i].length; j++) {
        if ((allRows[i][j] || '').toLowerCase().trim() === l) {
          if (allRows[i][j + 1]) return allRows[i][j + 1];
          if (allRows[i + 1] && allRows[i + 1][0]) return allRows[i + 1][0];
        }
      }
    }
    return '';
  }

  const agencyIdx   = allRows.findIndex(r => r.some(c => /agency id/i.test(c)));
  const bookingRow  = agencyIdx >= 0 ? (allRows[agencyIdx + 1] || []) : [];

  const nameIdx     = allRows.findIndex(r => r.some(c => /^name$/i.test(c.trim())));
  const personalRow = nameIdx >= 0 ? (allRows[nameIdx + 1] || []) : [];

  const heightIdx   = allRows.findIndex(r => r.some(c => /^height$/i.test(c.trim())));
  const physicalRow = heightIdx >= 0 ? (allRows[heightIdx + 1] || []) : [];

  const addrIdx    = allRows.findIndex(r => r.some(c => /^address$/i.test(c.trim())));
  const addressRow = addrIdx >= 0 ? (allRows[addrIdx + 1] || []) : [];

  const arrestIdx  = allRows.findIndex(r => r.some(c => /arrest agency/i.test(c)));
  const arrestRow  = arrestIdx >= 0 ? (allRows[arrestIdx + 1] || []) : [];

  const charges = [];
  let inCharges = false;
  let currentCharge = null;

  for (let i = 0; i < allRows.length; i++) {
    const row  = allRows[i];
    const text = row.join('|').toLowerCase();

    if (!inCharges && text.includes('charges') && !text.includes('bond')) {
      inCharges = true;
      continue;
    }
    if (!inCharges) continue;
    if (/release information|attorney/i.test(text)) break;

    if (/^warrant$/i.test((row[0] || '').trim())) {
      if (currentCharge) charges.push(currentCharge);
      currentCharge = {
        warrant: row[1] || '', warrant_date: row[3] || '',
        case_number: '', otn: '', offense_date: '', code_section: '',
        description: '', type: '', counts: '', bond: '',
        disposition: '', bond_amount: '', bond_status: '',
      };
      continue;
    }
    if (/^case$/i.test((row[0] || '').trim()) && currentCharge) {
      currentCharge.case_number = row[1] || '';
      currentCharge.otn         = row[3] || '';
      continue;
    }
    if (text.includes('offense date') && text.includes('code section')) continue;
    if (/^disposition$/i.test((row[0] || '').trim()) && currentCharge) {
      currentCharge.disposition = row[1] || '';
      continue;
    }
    if (text.includes('bond amount') && currentCharge) {
      currentCharge.bond_amount = row.filter(c => c && !/bond amount/i.test(c)).pop() || '';
      continue;
    }
    if (text.includes('bond status') && currentCharge) {
      const idx = row.findIndex(c => /bond status/i.test(c));
      currentCharge.bond_status = row[idx + 1] || '';
      continue;
    }
    // Fee rows to skip — these are court/bond fees, not actual charges
    const FEE_KEYWORDS = [
      'indigent defense', 'jail construction', 'poptf', 'peace officer',
      'cobb county bond fee', 'staffing act', 'prosecutor training'
    ];
    const rowText = row.join(' ').toLowerCase();
    const isFeeRow = FEE_KEYWORDS.some(k => rowText.includes(k));
    if (isFeeRow) continue;

    // Offense row: has a meaningful description (col 2 or col 1 if N/A in col 0)
    // Pattern A: [offense_date, code_section, description, type, counts, bond]
    // Pattern B: [N/A, code_section, description, type, counts, bond]  (N/A offense date)
    if (currentCharge) {
      // Find the description — it's the longest cell that looks like a charge
      const isOffenseHeader = row.some(c => /^(offense date|code section|description|type|counts|bond)$/i.test(c.trim()));
      if (isOffenseHeader) continue;

      // Detect if col 0 is a date or 'N/A' (offense date column)
      const col0 = (row[0] || '').trim();
      const col1 = (row[1] || '').trim();
      const col2 = (row[2] || '').trim();
      const col3 = (row[3] || '').trim();
      const col4 = (row[4] || '').trim();
      const col5 = (row[5] || '').trim();

      const isDateOrNA = /^(n\/a|\d{1,2}\/\d{1,2}\/\d{4})$/i.test(col0);
      const hasOCGA    = /^OCGA/i.test(col1);
      const hasDesc    = col2.length > 4 &&
                         !['description','type','counts','bond','disposition'].includes(col2.toLowerCase());

      if (isDateOrNA && (hasOCGA || hasDesc)) {
        currentCharge.offense_date = col0;
        currentCharge.code_section = col1;
        currentCharge.description  = col2;
        currentCharge.type         = col3;
        currentCharge.counts       = col4;
        currentCharge.bond         = col5;
      }
    }
  }
  if (currentCharge) charges.push(currentCharge);

  // Find the actual total bond amount row (separate from per-charge bond)
  // It appears as a standalone row with just "Bond Amount" label and a dollar value
  let totalBondAmount = '';
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const joined = row.join('|');
    if (/bond amount/i.test(joined)) {
      // Find rightmost dollar-formatted cell
      const dollarCell = [...row].reverse().find(c => /^\$[\d,]+\.\d{2}$/.test((c || '').trim()));
      if (dollarCell) { totalBondAmount = dollarCell.trim(); break; }
    }
  }

  const relIdx     = allRows.findIndex(r => r.some(c => /^release date$/i.test(c.trim())));
  const releaseRow = relIdx >= 0 ? (allRows[relIdx + 1] || []) : [];

  let height = physicalRow[0] || '';
  if (/^\d{3,4}$/.test(height)) {
    const h = height.padStart(3, '0');
    height = `${h[0]}'${h.slice(1)}"`;
  }

  const RACE_MAP = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
  const raceSex  = (personalRow[2] || '').replace(/\s/g, '');
  const [rc, sc] = raceSex.split('/');
  const race     = RACE_MAP[rc] || rc || '';
  const sex      = sc === 'M' ? 'Male' : sc === 'F' ? 'Female' : sc || '';

  const rawSoid = (personalRow[4] || '').trim();
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';

  const firstCharge = charges[0] || {};
  const chargesDesc = charges.map(c => c.description).filter(Boolean).join('; ');
  const chargeType  = [...new Set(charges.map(c => {
    const t = (c.type || '').toLowerCase();
    if (t.includes('felony'))      return 'Felony';
    if (t.includes('misdemeanor')) return 'Misdemeanor';
    return c.type;
  }).filter(Boolean))].join('; ');

  return {
    event_id:            eventId,
    full_name:           personalRow[0] || '',
    original_name:       originalName   || '',
    county:              'Cobb',
    agency_id:           bookingRow[0]  || '',
    arrest_date_time:    bookingRow[1]  || '',
    booking_date:        bookingRow[2]  || '',
    end_of_booking_date: bookingRow[3]  || '',
    booking_number:      arrestRow[3]   || '',
    date_of_birth:       personalRow[1] || '',
    race,
    sex,
    height,
    weight:              physicalRow[1] || '',
    hair:                physicalRow[2] || '',
    eyes:                physicalRow[3] || '',
    address:             [addressRow[0], addressRow[1], addressRow[2], addressRow[3]].filter(Boolean).join(', '),
    place_of_birth:      findVal('place of birth'),
    custody_status:      personalRow[3] || '',
    is_released:         !txt.includes('not released'),
    days_in_custody:     personalRow[5] || '',
    release_date:        releaseRow[0]  || '',
    release_officer:     releaseRow[1]  || '',
    released_to:         releaseRow[2]  || '',
    arresting_agency:    arrestRow[0]   || '',
    arrest_officer:      arrestRow[1]   || '',
    location_of_arrest:  arrestRow[2]   || '',
    charges:             chargesDesc,
    charge_type:         chargeType,
    charges_detail:      charges,
    bonding_amount:      totalBondAmount || firstCharge.bond_amount || '',
    bond_status:         firstCharge.bond_status || '',
    bonding_company:     '',
    bondsman_name:       '',
    warrant:             firstCharge.warrant     || '',
    case_number:         firstCharge.case_number || '',
    otn:                 firstCharge.otn         || '',
    disposition:         firstCharge.disposition || '',
    attorney:            txt.includes('no attorney of record') ? '' : findVal('attorney'),
    processed:           false,
    locked:              false,
    scraped_at:          new Date().toISOString(),
  };
}

app.get('/health', async (req, res) => {
  const browser = await launchBrowser().catch(() => null);
  if (!browser) return res.json({ status: 'degraded', error: 'Browser launch failed' });
  await browser.close();
  res.json({ status: 'ok', proxy: `${PROXY_HOST}:${PROXY_PORT}`, timestamp: new Date().toISOString() });
});

app.get('/proxy-test', async (req, res) => {
  const t = Date.now();
  let browser;
  try {
    browser = await launchBrowser();
    const ctx  = await newContext(browser);
    const page = await ctx.newPage();
    await page.goto(BASE_URL + '/enter_name.shtm', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    const html  = (await page.content()).length;
    await ctx.close();
    await browser.close();
    res.json({ ok: true, proxy: `${PROXY_HOST}:${PROXY_PORT}`, page_title: title, html_length: html, ms: Date.now() - t });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, proxy: `${PROXY_HOST}:${PROXY_PORT}`, error: err.message, ms: Date.now() - t,
      hint: 'Check PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS in Railway Variables' });
  }
});

app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body || {};
  if (!name && !soid) return res.status(400).json({ success: false, error: 'Provide name or soid' });

  const searchName = name ? formatName(name) : '';
  console.log(`\n[scrape] ── "${name || soid}" → "${searchName}" ──`);

  try {
    const result = await scrapeInmate(searchName, soid || '');
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[scrape] ❌ ${err.message}`);
    return res.status(500).json({
      success: false,
      error:   err.message,
      name:    name || soid || '',
      hint:    err.message.includes('timeout') || err.message.includes('ERR_')
        ? 'Proxy issue. Check PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS in Railway Variables.'
        : undefined,
    });
  }
});

app.post('/admissions', async (req, res) => {
  const url = BASE_URL + '/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions';
  let browser;
  try {
    browser = await launchBrowser();
    const ctx  = await newContext(browser);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const inmates = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
        const c = Array.from(row.querySelectorAll('td')).map(td => (td.innerText || '').trim());
        if (!c[1] || c[1].length < 2) return null;
        return { name: c[1], dob: c[2], race: c[3], sex: c[4], location: c[5], soid: c[6], days_in_custody: c[7] };
      }).filter(Boolean)
    );
    await ctx.close();
    await browser.close();
    res.json({ success: true, count: inmates.length, inmates });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cobb County Scraper on port ${PORT}`);
  console.log(`   Proxy:  ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`   Routes: GET /health  GET /proxy-test  POST /scrape  POST /admissions`);
});
