'use strict';

const express      = require('express');
const { chromium } = require('playwright');

const app  = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PROXY_HOST = process.env.PROXY_HOST || '23.95.150.145';
const PROXY_PORT = process.env.PROXY_PORT || '6114';
const PROXY_USER = process.env.PROXY_USER || 'nblqtupi';
const PROXY_PASS = process.env.PROXY_PASS || 'fg7nriv9yb5p';
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
        window.open = (url) => { resolve(url); return null; };
        const buttons = Array.from(document.querySelectorAll('input[type="submit"], button, input[type="button"]'));
        const bookingBtn = buttons.find(b =>
          /last/i.test(b.value || b.innerText || '') ||
          /booking/i.test(b.value || b.innerText || '')
        );
        if (bookingBtn) { bookingBtn.click(); } else { resolve(null); }
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

    // ── Parse using DOM directly for accuracy ─────────────────
    const extracted = await page.evaluate(() => {

      function cellText(el) { return (el?.innerText || '').trim(); }

      function findRowAfter(labelText) {
        const all = Array.from(document.querySelectorAll('tr'));
        for (let i = 0; i < all.length; i++) {
          const cells = Array.from(all[i].querySelectorAll('td,th')).map(c => cellText(c).toLowerCase());
          if (cells.some(c => c === labelText.toLowerCase())) {
            const next = all[i + 1];
            if (next) return Array.from(next.querySelectorAll('td,th')).map(c => cellText(c));
          }
        }
        return [];
      }

      function findCellAfter(labelText) {
        const all = Array.from(document.querySelectorAll('td,th'));
        for (let i = 0; i < all.length; i++) {
          if (cellText(all[i]).toLowerCase() === labelText.toLowerCase()) {
            for (let j = i + 1; j < all.length; j++) {
              const v = cellText(all[j]);
              if (v && v.toLowerCase() !== labelText.toLowerCase()) return v;
            }
          }
        }
        return '';
      }

      // ── Booking info ────────────────────────────────────────
      const bookingRow  = findRowAfter('agency id');
      const personalRow = findRowAfter('name');
      const physicalRow = findRowAfter('height');
      const addressRow  = findRowAfter('address');
      const arrestRow   = findRowAfter('arrest agency');
      const releaseRow  = findRowAfter('release date');

      // ── Bondsman ────────────────────────────────────────────
      const allRows = Array.from(document.querySelectorAll('tr'));
      let caseWarrantVal = '';
      let bondsmanName   = '';
      for (const row of allRows) {
        const cells = Array.from(row.querySelectorAll('td,th')).map(c => cellText(c));
        const joined = cells.join('|').toLowerCase();
        if (joined.includes('case/warrant') && joined.includes('bondsman')) {
          const nextRow = row.nextElementSibling;
          if (nextRow) {
            const nc = Array.from(nextRow.querySelectorAll('td,th')).map(c => cellText(c));
            caseWarrantVal = nc[0] || '';
            bondsmanName   = nc[1] || '';
          }
          break;
        }
      }

      // ── Bond status ─────────────────────────────────────────
      let bondStatusVal = '';
      for (const row of allRows) {
        const cells = Array.from(row.querySelectorAll('td,th')).map(c => cellText(c));
        const joined = cells.join('|').toLowerCase();
        if (joined.includes('bond status')) {
          const idx = cells.findIndex(c => /bond status/i.test(c));
          bondStatusVal = cells[idx + 1] || '';
          break;
        }
      }

      // ── Bond amount (first big dollar amount after "Bond Amount" header) ──
      let bondAmountVal = '';
      for (let i = 0; i < allRows.length; i++) {
        const cells = Array.from(allRows[i].querySelectorAll('td,th')).map(c => cellText(c));
        if (cells.some(c => /^bond amount$/i.test(c.trim()))) {
          // The amount is in the same row as a last cell, or next row
          const amt = cells.find(c => /^\$[\d,]+\.\d{2}$/.test(c.trim()));
          if (amt) { bondAmountVal = amt; break; }
          const nextCells = Array.from((allRows[i+1] || document.createElement('tr')).querySelectorAll('td,th')).map(c => cellText(c));
          const amt2 = nextCells.find(c => /^\$[\d,]+\.\d{2}$/.test(c.trim()));
          if (amt2) { bondAmountVal = amt2; break; }
        }
      }

      // ── Charges — parse each block precisely ────────────────
      // Structure per charge:
      //   Warrant | [num] | Warrant Date | [date] | [count]
      //   Case    | [num] | OTN | [otn]
      //   Offense Date | Code Section | Description | Type | Counts | Bond
      //   [N/A]   | [OCGA...]  | [Crime description (Type)] | [Type] | [n] | [$]
      //   Disposition | [value]
      //   [next charge or Bond Amount section]

      const charges = [];
      let inCharges    = false;
      let currentCharge = null;
      let seenOffenseHeader = false;

      // Known non-crime strings to skip
      const skipDesc = new Set([
        'description','n/a','','bond amount','bond status','indigent defense fund',
        'jail construction & staffing act fund',
        'poptf (peace officer & prosecutor training fund)',
        'cobb county bond fee','bonding info','bonding company',
      ]);

      for (let i = 0; i < allRows.length; i++) {
        const row   = allRows[i];
        const cells = Array.from(row.querySelectorAll('td,th')).map(c => cellText(c));
        const text  = cells.join('|').toLowerCase();

        // Enter charges section
        if (!inCharges) {
          if (cells.some(c => /^charges$/i.test(c.trim()))) { inCharges = true; }
          continue;
        }

        // Exit charges section
        if (/release information/i.test(text) || /^attorney$/i.test(cells[0]?.trim())) break;

        // Warrant line: first cell is "Warrant"
        if (/^warrant$/i.test(cells[0]?.trim())) {
          if (currentCharge) charges.push(currentCharge);
          currentCharge = {
            warrant:      cells[1] || '',
            warrant_date: cells[3] || '',
            case_number:  '',
            otn:          '',
            offense_date: '',
            code_section: '',
            description:  '',
            type:         '',
            counts:       '',
            bond:         '',
            disposition:  '',
            bond_amount:  '',
            bond_status:  '',
          };
          seenOffenseHeader = false;
          continue;
        }

        if (!currentCharge) continue;

        // Case line
        if (/^case$/i.test(cells[0]?.trim())) {
          currentCharge.case_number = cells[1] || '';
          currentCharge.otn         = cells[3] || '';
          continue;
        }

        // Offense Date / Code Section / Description header row — skip it
        if (text.includes('offense date') && text.includes('code section') && text.includes('description')) {
          seenOffenseHeader = true;
          continue;
        }

        // Stop collecting charges at Bond Amount section
        if (/^bond amount$/i.test(cells[0]?.trim()) || text.includes('bond amount')) {
          const amt = cells.find(c => /^\$[\d,]+\.\d{2}$/.test(c.trim()));
          if (amt) currentCharge.bond_amount = amt;
          continue;
        }

        // Bond Status
        if (text.includes('bond status')) {
          const idx = cells.findIndex(c => /bond status/i.test(c));
          currentCharge.bond_status = cells[idx + 1] || '';
          continue;
        }

        // Disposition — only "Disposition" as first cell, value is next cell
        if (/^disposition$/i.test(cells[0]?.trim())) {
          // Only grab if value is NOT a dollar amount or fee name
          const val = cells[1] || '';
          if (val && !/^\$/.test(val) && !skipDesc.has(val.toLowerCase())) {
            currentCharge.disposition = val;
          }
          continue;
        }

        // Charge data row — after seeing the offense header
        // cells: [OffenseDate, CodeSection, Description, Type, Counts, Bond]
        if (seenOffenseHeader && cells.length >= 3) {
          const desc = cells[2] || '';
          // Must be a real crime description — not a dollar amount, not a fee
          if (
            desc &&
            desc.length > 3 &&
            !skipDesc.has(desc.toLowerCase()) &&
            !/^\$[\d,]+/.test(desc) &&
            !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(desc)
          ) {
            currentCharge.offense_date = cells[0] || '';
            currentCharge.code_section = cells[1] || '';
            currentCharge.description  = desc;
            currentCharge.type         = cells[3] || '';
            currentCharge.counts       = cells[4] || '';
            currentCharge.bond         = cells[5] || '';
          }
        }
      }
      if (currentCharge) charges.push(currentCharge);

      const bodyText = (document.body?.innerText || '').toLowerCase();

      return {
        bookingRow, personalRow, physicalRow, addressRow, arrestRow, releaseRow,
        caseWarrantVal, bondsmanName, bondStatusVal, bondAmountVal,
        charges,
        isReleased:  !bodyText.includes('not released'),
        noAttorney:  bodyText.includes('no attorney of record'),
        attorney:    bodyText.includes('no attorney of record') ? '' : '',
      };
    });

    // Get attorney separately since findCellAfter not available in above scope
    const attorney = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      if (bodyText.includes('no attorney of record')) return '';
      const all = Array.from(document.querySelectorAll('td,th'));
      for (let i = 0; i < all.length; i++) {
        if ((all[i].innerText||'').trim().toLowerCase() === 'attorney') {
          for (let j = i+1; j < all.length; j++) {
            const v = (all[j].innerText||'').trim();
            if (v && v.toLowerCase() !== 'attorney') return v;
          }
        }
      }
      return '';
    });

    extracted.attorney = attorney;

    console.log(`[scrape] ✅ Scraped ${extracted.charges.length} charges`);
    console.log(`[scrape] Charges: ${extracted.charges.map(c => c.description).join(' | ')}`);

    const data = buildRecord(extracted, searchName || soidVal);

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

function buildRecord(ex, originalName) {
  const bookingRow  = ex.bookingRow  || [];
  const personalRow = ex.personalRow || [];
  const physicalRow = ex.physicalRow || [];
  const addressRow  = ex.addressRow  || [];
  const arrestRow   = ex.arrestRow   || [];
  const releaseRow  = ex.releaseRow  || [];
  const charges     = ex.charges     || [];

  // Height formatting
  let height = physicalRow[0] || '';
  if (/^\d{3,4}$/.test(height)) {
    const h = height.padStart(3, '0');
    height = `${h[0]}'${h.slice(1)}"`;
  }

  // Race / Sex
  const RACE_MAP = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
  const raceSex  = (personalRow[2] || '').replace(/\s/g, '');
  const [rc, sc] = raceSex.split('/');
  const race     = RACE_MAP[rc] || rc || '';
  const sex      = sc === 'M' ? 'Male' : sc === 'F' ? 'Female' : sc || '';

  // SOID / event_id
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
    place_of_birth:      '',
    custody_status:      personalRow[3] || '',
    is_released:         ex.isReleased,
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
    bonding_amount:      ex.bondAmountVal  || firstCharge.bond_amount || '',
    bond_status:         ex.bondStatusVal  || firstCharge.bond_status || '',
    bonding_company:     ex.bondsmanName   || '',
    bondsman_name:       ex.bondsmanName   || '',
    case_warrant:        ex.caseWarrantVal || '',
    warrant:             firstCharge.warrant     || '',
    case_number:         firstCharge.case_number || '',
    otn:                 firstCharge.otn         || '',
    disposition:         firstCharge.disposition || '',
    attorney:            ex.attorney || '',
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

app.get('/debug', async (req, res) => {
  const t = Date.now();
  let browser;
  try {
    browser = await launchBrowser();
    const ctx  = await newContext(browser);
    const page = await ctx.newPage();
    const targetUrl = req.query.url || (BASE_URL + '/enter_name.shtm');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    const title  = await page.title();
    const html   = await page.content();
    const finalUrl = page.url();
    await ctx.close();
    await browser.close();
    res.json({
      ok: true,
      proxy: `${PROXY_HOST}:${PROXY_PORT}`,
      final_url: finalUrl,
      page_title: title,
      html_length: html.length,
      html_preview: html.substring(0, 2000),
      ms: Date.now() - t
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, error: err.message, ms: Date.now() - t });
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
