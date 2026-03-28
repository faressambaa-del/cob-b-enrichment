/**
 * Cobb County Sheriff Inmate Scraper
 *
 * PAGE FLOW (matches screenshots exactly):
 *  1. GET  /enter_name.shtm          → get ASP session cookie
 *  2. POST /inquiry.asp              → search by name, qry=Inquiry (dropdown)
 *     body: soid=&name=LASTNAME+FIRSTNAME&serial=&B1=Search&qry=Inquiry
 *  3. Parse results table            → extract SOID + BOOKING_ID from
 *                                       "Last Known Booking" button form
 *  4. GET  /InmDetails.asp?soid=...&BOOKING_ID=...  → full booking detail page
 *  5. Parse detail page              → all fields from Arrest/Booking Report
 */

const express      = require('express');
const { chromium } = require('playwright');
const http         = require('http');

const app = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';
const FORM_URL = BASE_URL + '/enter_name.shtm';

// ── Proxy config (set these in Railway → Variables) ───────────
const PROXY_HOST = process.env.PROXY_HOST || '31.59.20.176';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '6754', 10);
const PROXY_USER = process.env.PROXY_USER || 'bhkcvqwz';
const PROXY_PASS = process.env.PROXY_PASS || '8o7dd3heu5b3';

function proxyRequest({ method = 'GET', targetUrl, postBody = null, cookies = [], extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const auth      = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

    const headers = {
      'Host':                new URL(targetUrl).host,
      'User-Agent':          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept':              'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language':     'en-US,en;q=0.9',
      'Proxy-Authorization': `Basic ${auth}`,
      'Connection':          'close',
      ...extraHeaders,
    };
    if (cookieStr)  headers['Cookie']          = cookieStr;
    if (postBody) {
      headers['Content-Type']   = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(postBody);
    }

    const req = http.request(
      { host: PROXY_HOST, port: PROXY_PORT, method, path: targetUrl, headers },
      (resp) => {
        let body = '';
        resp.on('data', c => { body += c; });
        resp.on('end', () => resolve({
          status:   resp.statusCode,
          headers:  resp.headers,
          cookies:  resp.headers['set-cookie'] || [],
          location: resp.headers['location'] || null,
          body,
        }));
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out after 30s')));
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

async function withRetry(fn, attempts = 3, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      console.log(`[retry] ${i + 1}/${attempts}: ${err.message}`);
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getSessionCookie() {
  console.log(`[session] GET ${FORM_URL}`);
  const r = await proxyRequest({ targetUrl: FORM_URL });
  console.log(`[session] ${r.status} | body:${r.body.length} | cookies:${JSON.stringify(r.cookies)}`);
  if (r.status === 407)  throw new Error('Proxy auth failed (407) — update PROXY_USER/PROXY_PASS');
  if (r.body.toLowerCase().includes('bad gateway')) throw new Error('Proxy bad gateway — update PROXY_HOST/PROXY_PORT');
  if (r.status !== 200)  throw new Error(`Session GET returned ${r.status}`);
  return { cookies: r.cookies, body: r.body };
}

async function submitSearch(sessionCookies, searchName, soidVal) {
  let postBody;
  if (soidVal) {
    postBody = `soid=${encodeURIComponent(soidVal)}&name=&serial=&B1=Search&qry=Inquiry`;
  } else {
    postBody = `soid=&name=${encodeURIComponent(searchName).replace(/%20/g, '+')}&serial=&B1=Search&qry=Inquiry`;
  }

  console.log(`[search] POST /inquiry.asp  body=${postBody}`);
  const r = await proxyRequest({
    method:    'POST',
    targetUrl: BASE_URL + '/inquiry.asp',
    postBody,
    cookies:   sessionCookies,
    extraHeaders: {
      'Referer': FORM_URL,
      'Origin':  BASE_URL,
      'Cache-Control': 'no-cache',
    },
  });
  console.log(`[search] ${r.status} | body:${r.body.length} | loc:${r.location || 'none'}`);
  return { ...r, cookies: [...sessionCookies, ...r.cookies] };
}

async function getPage(url, cookies, referer) {
  const r = await proxyRequest({
    targetUrl:    url,
    cookies,
    extraHeaders: referer ? { 'Referer': referer } : {},
  });
  console.log(`[get] ${url} → ${r.status} | ${r.body.length} chars`);
  return { ...r, cookies: [...cookies, ...r.cookies] };
}

async function parseHtml(browser, html) {
  const ctx  = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return { page, ctx };
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--no-zygote','--single-process'],
  });
}

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

async function parseResultsPage(page) {
  return page.evaluate(() => {
    const results = [];
    const rows = Array.from(document.querySelectorAll('table tr'));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 6) continue;

      const nameCell = (cells[1]?.innerText || '').trim();
      if (!nameCell || nameCell.length < 2) continue;
      if (nameCell.toLowerCase() === 'name') continue;
      if (nameCell.toLowerCase().includes('image')) continue;

      let bookingId = '';
      let soidFromForm = '';
      let detailUrl = '';

      for (const form of row.querySelectorAll('form')) {
        const inputs = {};
        form.querySelectorAll('input').forEach(inp => {
          inputs[(inp.name || '').toUpperCase()] = inp.value || '';
        });
        if (inputs['BOOKING_ID']) {
          bookingId    = inputs['BOOKING_ID'];
          soidFromForm = inputs['SOID'] || '';
        }
      }

      for (const a of row.querySelectorAll('a')) {
        const href = a.href || a.getAttribute('href') || '';
        if (href.toLowerCase().includes('inmdetails')) {
          detailUrl = href;
          if (!bookingId) {
            try {
              const u = new URL(href, 'http://inmate-search.cobbsheriff.org');
              bookingId    = u.searchParams.get('BOOKING_ID') || '';
              soidFromForm = u.searchParams.get('soid') || soidFromForm;
            } catch (e) {}
          }
        }
      }

      const soid = (cells[6]?.innerText || '').trim();

      results.push({
        name:            nameCell,
        dob:             (cells[2]?.innerText || '').trim(),
        race:            (cells[3]?.innerText || '').trim(),
        sex:             (cells[4]?.innerText || '').trim(),
        location:        (cells[5]?.innerText || '').trim(),
        soid,
        days_in_custody: (cells[7]?.innerText || '').trim(),
        booking_id:      bookingId,
        soid_from_form:  soidFromForm || soid,
        detail_url:      detailUrl,
      });
    }

    return results;
  });
}

async function parseDetailPage(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').toLowerCase();

    function cellAfter(label) {
      const all = Array.from(document.querySelectorAll('td, th'));
      for (let i = 0; i < all.length; i++) {
        const t = (all[i].innerText || '').trim().toLowerCase();
        if (t !== label.toLowerCase()) continue;
        let sib = all[i].nextElementSibling;
        while (sib) {
          if (sib.tagName === 'TD' || sib.tagName === 'TH') {
            const v = (sib.innerText || '').trim();
            if (v && v.toLowerCase() !== label.toLowerCase()) return v;
          }
          sib = sib.nextElementSibling;
        }
        const tr = all[i].closest('tr');
        if (tr?.nextElementSibling) {
          const td = tr.nextElementSibling.querySelector('td');
          if (td) return (td.innerText || '').trim();
        }
      }
      return '';
    }

    function rowAfter(label) {
      const all = Array.from(document.querySelectorAll('td, th'));
      for (let i = 0; i < all.length; i++) {
        const t = (all[i].innerText || '').trim().toLowerCase();
        if (t !== label.toLowerCase()) continue;
        const tr = all[i].closest('tr');
        if (tr?.nextElementSibling) {
          return Array.from(tr.nextElementSibling.querySelectorAll('td, th'))
            .map(c => (c.innerText || '').trim());
        }
      }
      return [];
    }

    const bookingRow  = rowAfter('agency id');
    const personalRow = rowAfter('name');
    const physicalRow = rowAfter('height');
    const addressRow  = rowAfter('address');
    const arrestRow   = rowAfter('arrest agency');

    const charges = [];
    const allRows = Array.from(document.querySelectorAll('tr'));
    let inChargeSection = false;
    let inChargeData    = false;
    let currentCharge   = null;

    const skipLabels = new Set([
      'offense date','code section','description','type','counts','bond',
      'warrant','case','otn','disposition','bond amount','bond status',
      'charges','n/a','',
    ]);

    for (let ri = 0; ri < allRows.length; ri++) {
      const row   = allRows[ri];
      const cells = Array.from(row.querySelectorAll('td, th')).map(c => (c.innerText || '').trim());
      const text  = cells.join('|').toLowerCase();

      if (!inChargeSection && text.includes('charges') && !text.includes('bond')) {
        inChargeSection = true;
        continue;
      }
      if (!inChargeSection) continue;
      if (text.includes('release information') || text.includes('attorney')) break;

      if (text.includes('warrant') && !text.includes('case') && cells[0]?.toLowerCase() === 'warrant') {
        if (currentCharge) charges.push(currentCharge);
        currentCharge = {
          warrant: cells[1] || '', warrant_date: cells[3] || '', warrant_count: cells[4] || '',
          case_number: '', otn: '', offense_date: '', code_section: '',
          description: '', type: '', counts: '', bond: '', disposition: '', bond_amount: '', bond_status: '',
        };
        inChargeData = false;
        continue;
      }

      if (cells[0]?.toLowerCase() === 'case' && currentCharge) {
        currentCharge.case_number = cells[1] || '';
        currentCharge.otn         = cells[3] || '';
        continue;
      }

      if (text.includes('offense date') && text.includes('code section')) {
        inChargeData = true;
        continue;
      }

      if (inChargeData && currentCharge && cells.length >= 3) {
        const desc = cells[2] || '';
        if (desc && !skipLabels.has(desc.toLowerCase()) && desc.toLowerCase() !== 'n/a') {
          currentCharge.offense_date = cells[0] || currentCharge.offense_date;
          currentCharge.code_section = cells[1] || currentCharge.code_section;
          currentCharge.description  = desc;
          currentCharge.type         = cells[3] || '';
          currentCharge.counts       = cells[4] || '';
          currentCharge.bond         = cells[5] || '';
          inChargeData = false;
        }
        continue;
      }

      if (cells[0]?.toLowerCase() === 'disposition' && currentCharge) {
        currentCharge.disposition = cells[1] || '';
        continue;
      }

      if (text.includes('bond amount') && currentCharge) {
        const amount = cells.filter(c => c && c !== 'Bond Amount').pop() || '';
        currentCharge.bond_amount = amount;
        continue;
      }

      if (text.includes('bond status') && currentCharge) {
        const idx = cells.findIndex(c => c.toLowerCase() === 'bond status');
        currentCharge.bond_status = cells[idx + 1] || '';
        continue;
      }
    }
    if (currentCharge) charges.push(currentCharge);

    const releaseRow = rowAfter('release date');

    let height = physicalRow[0] || '';
    if (/^\d{3,4}$/.test(height)) {
      const h = height.padStart(3, '0');
      height  = `${h[0]}'${h.slice(1)}"`;
    }

    const raceSex = (personalRow[2] || '').replace(/\s/g, '');
    const [raceCode, sexCode] = raceSex.split('/');

    return {
      agency_id:          bookingRow[0] || '',
      arrest_date_time:   bookingRow[1] || '',
      booking_started:    bookingRow[2] || '',
      booking_complete:   bookingRow[3] || '',
      full_name:          personalRow[0] || '',
      dob:                personalRow[1] || '',
      race_code:          raceCode || '',
      sex_code:           sexCode  || '',
      location:           personalRow[3] || '',
      soid:               personalRow[4] || '',
      days_in_custody:    personalRow[5] || '',
      height,
      weight:             physicalRow[1] || '',
      hair:               physicalRow[2] || '',
      eyes:               physicalRow[3] || '',
      address:            addressRow[0] || '',
      city:               addressRow[1] || '',
      state:              addressRow[2] || '',
      zip:                addressRow[3] || '',
      place_of_birth:     cellAfter('place of birth'),
      arresting_agency:   arrestRow[0] || '',
      arrest_officer:     arrestRow[1] || '',
      location_of_arrest: arrestRow[2] || '',
      serial_number:      arrestRow[3] || '',
      charges,
      release_date:       releaseRow[0] || '',
      release_officer:    releaseRow[1] || '',
      released_to:        releaseRow[2] || '',
      is_released:        !bodyText.includes('not released'),
      attorney:           bodyText.includes('no attorney of record') ? '' : cellAfter('attorney'),
    };
  });
}

const RACE_MAP = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };

function buildRecord(detail, summaryRow, originalName) {
  const race = RACE_MAP[detail.race_code] || detail.race_code || RACE_MAP[summaryRow.race] || summaryRow.race || '';
  const sex  = detail.sex_code === 'M' ? 'Male' : detail.sex_code === 'F' ? 'Female' : detail.sex_code || summaryRow.sex || '';

  const chargesDesc = detail.charges.map(c => c.description).filter(Boolean).join('; ');
  const chargeType  = [...new Set(detail.charges.map(c => {
    const t = (c.type || '').toLowerCase();
    if (t.includes('felony'))      return 'Felony';
    if (t.includes('misdemeanor')) return 'Misdemeanor';
    return c.type;
  }).filter(Boolean))].join('; ');

  const rawSoid = (detail.soid || summaryRow.soid || '').trim();
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';
  const firstCharge = detail.charges[0] || {};

  return {
    event_id:             eventId,
    full_name:            detail.full_name || summaryRow.name || '',
    original_name:        originalName || '',
    county:               'Cobb',
    agency_id:            detail.agency_id,
    arrest_date_time:     detail.arrest_date_time,
    booking_date:         detail.booking_started,
    end_of_booking_date:  detail.booking_complete,
    booking_number:       detail.serial_number,
    date_of_birth:        detail.dob || summaryRow.dob || '',
    race,
    sex,
    height:               detail.height,
    weight:               detail.weight,
    hair:                 detail.hair,
    eyes:                 detail.eyes,
    address:              [detail.address, detail.city, detail.state, detail.zip].filter(Boolean).join(', '),
    place_of_birth:       detail.place_of_birth,
    custody_status:       detail.location || summaryRow.location || '',
    is_released:          detail.is_released,
    days_in_custody:      detail.days_in_custody || summaryRow.days_in_custody || '',
    release_date:         detail.release_date,
    release_officer:      detail.release_officer,
    released_to:          detail.released_to,
    arresting_agency:     detail.arresting_agency,
    arrest_officer:       detail.arrest_officer,
    location_of_arrest:   detail.location_of_arrest,
    charges:              chargesDesc,
    charge_type:          chargeType,
    charges_detail:       detail.charges,
    bonding_amount:       firstCharge.bond_amount || '',
    bond_status:          firstCharge.bond_status || '',
    bonding_company:      '',
    bondsman_name:        '',
    warrant:              firstCharge.warrant || '',
    case_number:          firstCharge.case_number || '',
    otn:                  firstCharge.otn || '',
    disposition:          firstCharge.disposition || '',
    attorney:             detail.attorney,
    processed:            false,
    locked:               false,
    scraped_at:           new Date().toISOString(),
  };
}

function buildSummaryRecord(row, originalName) {
  const rawSoid = (row.soid || '').trim();
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';
  const race    = RACE_MAP[(row.race || '').trim()] || row.race || '';
  const sex     = row.sex === 'M' ? 'Male' : row.sex === 'F' ? 'Female' : row.sex || '';
  return {
    event_id: eventId, full_name: row.name, original_name: originalName,
    county: 'Cobb', date_of_birth: row.dob, race, sex,
    custody_status: row.location, is_released: (row.location || '').toUpperCase() === 'RELEASED',
    days_in_custody: row.days_in_custody,
    charges: '', charge_type: '', bonding_amount: '', bond_status: '',
    processed: false, locked: false, scraped_at: new Date().toISOString(),
  };
}

app.get('/health', async (req, res) => {
  try {
    const r = await getSessionCookie();
    res.json({ status: 'ok', proxy: `${PROXY_HOST}:${PROXY_PORT}`, site_reachable: true, cookies: r.cookies.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ status: 'degraded', error: err.message, proxy: `${PROXY_HOST}:${PROXY_PORT}`, hint: 'Update PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS in Railway Variables', timestamp: new Date().toISOString() });
  }
});

app.get('/proxy-test', async (req, res) => {
  const t = Date.now();
  try {
    const r = await proxyRequest({ targetUrl: FORM_URL });
    res.json({ ok: r.status === 200, proxy: `${PROXY_HOST}:${PROXY_PORT}`, http_status: r.status, body_length: r.body.length, cookies: r.cookies, ms: Date.now() - t });
  } catch (err) {
    res.json({ ok: false, proxy: `${PROXY_HOST}:${PROXY_PORT}`, error: err.message, ms: Date.now() - t,
      hint: '"socket hang up" = proxy IP dead. "407" = wrong credentials. Fix env vars in Railway.' });
  }
});

app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;
  if (!name && !soid) return res.status(400).json({ success: false, error: 'Provide name or soid' });

  const searchName = name ? formatName(name) : '';
  console.log(`\n[scrape] ── START "${name || soid}" → search:"${searchName}" ──`);

  let browser;
  try {
    browser = await launchBrowser();

    console.log('[scrape] Step 1 — session cookie');
    const session = await withRetry(() => getSessionCookie(), 3, 3000);
    let cookies = session.cookies;

    console.log('[scrape] Step 2 — submit search (qry=Inquiry)');
    const searchResult = await withRetry(() => submitSearch(cookies, searchName, soid), 2, 2000);
    cookies = searchResult.cookies;

    let resultsHtml = searchResult.body;
    if (searchResult.status === 301 || searchResult.status === 302) {
      const loc  = searchResult.location || '';
      const dest = loc.startsWith('http') ? loc : BASE_URL + loc;
      console.log(`[scrape] redirect → ${dest}`);
      const redir = await getPage(dest, cookies, BASE_URL + '/inquiry.asp');
      resultsHtml = redir.body;
      cookies     = redir.cookies;
    }
    console.log(`[scrape] results HTML: ${resultsHtml.length} chars`);

    console.log('[scrape] Step 3 — parse results');
    const { page: rPage, ctx: rCtx } = await parseHtml(browser, resultsHtml);

    const bodyText = (await rPage.textContent('body').catch(() => '')).toLowerCase();
    const hasTable = (await rPage.$('table')) !== null;

    if (!hasTable || bodyText.includes('no record') || bodyText.includes('no match') || bodyText.includes('not found')) {
      await rCtx.close(); await browser.close();
      console.log('[scrape] No results found');
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    const rows = await parseResultsPage(rPage);
    await rCtx.close();
    console.log(`[scrape] Found ${rows.length} row(s): ${JSON.stringify(rows.map(r => r.name))}`);

    if (!rows.length) {
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    const summaryRow = rows[0];
    console.log(`[scrape] Using: "${summaryRow.name}" SOID:${summaryRow.soid} BookingID:${summaryRow.booking_id}`);

    if (!summaryRow.booking_id && !summaryRow.detail_url) {
      console.log('[scrape] No BOOKING_ID — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, detail: false, data: buildSummaryRecord(summaryRow, name || soid) });
    }

    let detailUrl;
    if (summaryRow.detail_url) {
      detailUrl = summaryRow.detail_url.startsWith('http')
        ? summaryRow.detail_url
        : BASE_URL + '/' + summaryRow.detail_url.replace(/^\//, '');
    } else {
      const s = encodeURIComponent((summaryRow.soid_from_form || summaryRow.soid || '').trim());
      const b = encodeURIComponent(summaryRow.booking_id);
      detailUrl = `${BASE_URL}/InmDetails.asp?soid=${s}&BOOKING_ID=${b}`;
    }

    console.log(`[scrape] Step 4 — detail: ${detailUrl}`);
    const detailResult = await getPage(detailUrl, cookies, BASE_URL + '/inquiry.asp');

    if (!detailResult.body || detailResult.body.includes('Error_Page') || detailResult.body.includes('Unauthorised')) {
      console.log('[scrape] Detail page error — summary only');
      await browser.close();
      return res.json({ success: true, found: true, detail: false, data: buildSummaryRecord(summaryRow, name || soid) });
    }

    console.log('[scrape] Step 5 — parse detail page');
    const { page: dPage, ctx: dCtx } = await parseHtml(browser, detailResult.body);
    const detail = await parseDetailPage(dPage);
    await dCtx.close();
    await browser.close();

    const record = buildRecord(detail, summaryRow, name || soid);
    console.log(`[scrape] ✅ ${record.full_name} | booking:${record.booking_date} | charges:${record.charges.substring(0, 80)}`);

    return res.json({
      success:    true,
      found:      true,
      detail:     true,
      detail_url: detailUrl,
      scraped_at: new Date().toISOString(),
      data:       record,
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[scrape] ❌ "${name || soid}": ${err.message}`);
    return res.status(500).json({
      success: false,
      found:   false,
      error:   err.message,
      name:    name || soid || '',
      hint:    (err.message.includes('timed out') || err.message.includes('socket hang up'))
        ? 'Proxy is dead. Update PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS in Railway Variables.'
        : undefined,
    });
  }
});

app.post('/admissions', async (req, res) => {
  let browser;
  try {
    const session = await withRetry(() => getSessionCookie(), 3, 3000);
    const result  = await getPage(
      BASE_URL + '/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions',
      session.cookies, FORM_URL
    );
    browser = await launchBrowser();
    const { page, ctx } = await parseHtml(browser, result.body);
    await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
    const inmates = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
        const c = Array.from(row.querySelectorAll('td')).map(td => (td.innerText || '').trim());
        if (!c[1] || c[1].length < 2) return null;
        return { name: c[1], dob: c[2], race: c[3], sex: c[4], location: c[5], soid: c[6], days_in_custody: c[7] };
      }).filter(Boolean)
    );
    await ctx.close(); await browser.close();
    res.json({ success: true, count: inmates.length, inmates });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cobb County Scraper on port ${PORT}`);
  console.log(`   Proxy:  ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Routes: GET /health  GET /proxy-test  POST /scrape  POST /admissions`);
});
