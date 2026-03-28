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
const PROXY_USER = process.env.PROXY_USER || 'tznskjmn';
const PROXY_PASS = process.env.PROXY_PASS || 'ag3c9yyj3w0l';

// ─────────────────────────────────────────────────────────────
// RAW HTTP via forward proxy
// We connect to proxy and send the full target URL as the path.
// ─────────────────────────────────────────────────────────────
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

// ── Retry wrapper ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// STEP 1 — GET session cookie from the form page
// ─────────────────────────────────────────────────────────────
async function getSessionCookie() {
  console.log(`[session] GET ${FORM_URL}`);
  const r = await proxyRequest({ targetUrl: FORM_URL });
  console.log(`[session] ${r.status} | body:${r.body.length} | cookies:${JSON.stringify(r.cookies)}`);
  if (r.status === 407)  throw new Error('Proxy auth failed (407) — update PROXY_USER/PROXY_PASS');
  if (r.body.toLowerCase().includes('bad gateway')) throw new Error('Proxy bad gateway — update PROXY_HOST/PROXY_PORT');
  if (r.status !== 200)  throw new Error(`Session GET returned ${r.status}`);
  return { cookies: r.cookies, body: r.body };
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — POST search form
//
// The form on enter_name.shtm has:
//   soid   = (empty for name search)
//   name   = LASTNAME FIRSTNAME  (site says "Last name space first name")
//   serial = (empty)
//   B1     = Search
//   qry    = Inquiry   ← the dropdown value we must set
//
// The site accepts the name as-is (space-separated, uppercase).
// We do NOT convert to "LAST,FIRST" format — the site format is
// "Last name (space) first name" as shown on the form.
// ─────────────────────────────────────────────────────────────
async function submitSearch(sessionCookies, searchName, soidVal) {
  // Build POST body matching the exact form fields
  let postBody;
  if (soidVal) {
    postBody = `soid=${encodeURIComponent(soidVal)}&name=&serial=&B1=Search&qry=Inquiry`;
  } else {
    // Name format: "GARCIA ELVIA" → sent as-is, spaces encoded as +
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

// ─────────────────────────────────────────────────────────────
// GET any page via proxy (for redirects + detail pages)
// ─────────────────────────────────────────────────────────────
async function getPage(url, cookies, referer) {
  const r = await proxyRequest({
    targetUrl:    url,
    cookies,
    extraHeaders: referer ? { 'Referer': referer } : {},
  });
  console.log(`[get] ${url} → ${r.status} | ${r.body.length} chars`);
  return { ...r, cookies: [...cookies, ...r.cookies] };
}

// ─────────────────────────────────────────────────────────────
// Parse HTML offline (Playwright setContent — no network)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Format name for search
// Input:  "Garcia, Elvia Yadira"  or  "GARCIA ELVIA"
// Output: "GARCIA ELVIA"   (LASTNAME FIRSTNAME, space-separated, uppercase)
//
// The site format shown on form: "Last name (space) first name"
// ─────────────────────────────────────────────────────────────
function formatName(raw) {
  if (!raw) return '';
  raw = raw.trim().toUpperCase();

  if (raw.includes(',')) {
    // "GARCIA, ELVIA YADIRA" → "GARCIA ELVIA"
    const [last, rest] = raw.split(',');
    const first = (rest || '').trim().split(/\s+/)[0];
    return `${last.trim()} ${first}`.trim();
  }
  // Already in "GARCIA ELVIA" format — return as-is
  return raw;
}

// ─────────────────────────────────────────────────────────────
// PARSE RESULTS PAGE
// Extracts all rows from the results table.
// Each row has: Name, DOB, Race, Sex, Location, SOID,
//               Days in Custody, Last Known Booking button.
//
// The "Last Known Booking" button is a form submit with hidden
// inputs: SOID and BOOKING_ID  →  posts to /InmDetails.asp
// ─────────────────────────────────────────────────────────────
async function parseResultsPage(page) {
  return page.evaluate(() => {
    const results = [];

    // Find every data row in the results table
    // Header row has th elements; data rows have td elements
    const rows = Array.from(document.querySelectorAll('table tr'));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 6) continue;

      // Skip header-like rows
      const nameCell = (cells[1]?.innerText || '').trim();
      if (!nameCell || nameCell.length < 2) continue;
      if (nameCell.toLowerCase() === 'name') continue;
      if (nameCell.toLowerCase().includes('image')) continue;

      // Extract the SOID and BOOKING_ID from the "Last Known Booking" form
      // The form is inside one of the cells (usually cell index 7 or 8)
      let bookingId = '';
      let soidFromForm = '';
      let detailUrl = '';

      // Search all forms in the row
      for (const form of row.querySelectorAll('form')) {
        const inputs = {};
        form.querySelectorAll('input[type="hidden"], input[type="submit"], input').forEach(inp => {
          inputs[(inp.name || '').toUpperCase()] = inp.value || '';
        });
        if (inputs['BOOKING_ID']) {
          bookingId    = inputs['BOOKING_ID'];
          soidFromForm = inputs['SOID'] || '';
        }
        // Also check form action for InmDetails
        const action = (form.getAttribute('action') || '').toLowerCase();
        if (action.includes('inmdetails') || action.includes('inm_details')) {
          const params = new URLSearchParams(form.action.split('?')[1] || '');
          if (!bookingId) bookingId = params.get('BOOKING_ID') || '';
        }
      }

      // Also look for <a href> links to InmDetails
      for (const a of row.querySelectorAll('a')) {
        const href = a.href || a.getAttribute('href') || '';
        if (href.toLowerCase().includes('inmdetails')) {
          detailUrl = href;
          // Extract from URL params if not already found
          if (!bookingId) {
            try {
              const u = new URL(href, 'http://inmate-search.cobbsheriff.org');
              bookingId    = u.searchParams.get('BOOKING_ID') || '';
              soidFromForm = u.searchParams.get('soid') || soidFromForm;
            } catch (e) {}
          }
        }
      }

      const soid = cells[6] ? (cells[6].innerText || '').trim() : '';

      results.push({
        name:            nameCell,
        dob:             (cells[2]?.innerText || '').trim(),
        race:            (cells[3]?.innerText || '').trim(),
        sex:             (cells[4]?.innerText || '').trim(),
        location:        (cells[5]?.innerText || '').trim(),
        soid:            soid,
        days_in_custody: (cells[7]?.innerText || '').trim(),
        booking_id:      bookingId,
        soid_from_form:  soidFromForm || soid,
        detail_url:      detailUrl,
      });
    }

    return results;
  });
}

// ─────────────────────────────────────────────────────────────
// PARSE DETAIL PAGE  (Arrest/Booking Report)
//
// Page sections (from screenshots):
//  ┌─ Booking Information ──────────────────────────────────┐
//  │ Agency ID | Arrest Date/Time | Booking Started | Booking Complete │
//  ├─ Personal Information ─────────────────────────────────┤
//  │ Name | DOB | Race/Sex | Location | SOID | Days in Custody │
//  │ Height | Weight | Hair | Eyes                          │
//  │ Address | City | State | Zip                           │
//  │ Place of Birth                                         │
//  ├─ Visible Scars and Marks ──────────────────────────────┤
//  ├─ Arrest Circumstances ─────────────────────────────────┤
//  │ Arrest Agency | Officer | Location of Arrest | Serial # │
//  ├─ Charges ──────────────────────────────────────────────┤
//  │ Warrant | [number] | Warrant Date | [date] | [count]  │
//  │ Case | [number]    | OTN | [number]                    │
//  │ Offense Date | Code Section | Description | Type | Counts | Bond │
//  │ Disposition | [value]                                  │
//  │ Bond Amount | [value]                                  │
//  │ Bond Status | [value]                                  │
//  ├─ Release Information ───────────────────────────────────┤
//  │ Attorney | [name or "No Attorney of Record on file"]   │
//  │ Release Date | Officer | Released To                   │
//  │ Not Released  OR  [date]                               │
//  └────────────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────
async function parseDetailPage(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').toLowerCase();

    // Helper: find the value cell(s) after a header cell with given label
    function cellAfter(label) {
      const all = Array.from(document.querySelectorAll('td, th'));
      for (let i = 0; i < all.length; i++) {
        const t = (all[i].innerText || '').trim().toLowerCase();
        if (t !== label.toLowerCase()) continue;
        // Try next sibling TDs in same row
        let sib = all[i].nextElementSibling;
        while (sib) {
          if (sib.tagName === 'TD' || sib.tagName === 'TH') {
            const v = (sib.innerText || '').trim();
            if (v && v.toLowerCase() !== label.toLowerCase()) return v;
          }
          sib = sib.nextElementSibling;
        }
        // Try first TD in next row
        const tr = all[i].closest('tr');
        if (tr?.nextElementSibling) {
          const td = tr.nextElementSibling.querySelector('td');
          if (td) return (td.innerText || '').trim();
        }
      }
      return '';
    }

    // Helper: get all TDs in the row AFTER the row containing label
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

    // ── Booking Information row ───────────────────────────────
    const bookingRow = rowAfter('agency id');
    // bookingRow: [AgencyID, ArrestDateTime, BookingStarted, BookingComplete]

    // ── Personal Information rows ─────────────────────────────
    const personalRow = rowAfter('name');
    // personalRow: [Name, DOB, Race/Sex, Location, SOID, DaysInCustody]

    const physicalRow = rowAfter('height');
    // physicalRow: [Height, Weight, Hair, Eyes]

    const addressRow = rowAfter('address');
    // addressRow: [Address, City, State, Zip]

    // ── Arrest Circumstances ──────────────────────────────────
    const arrestRow = rowAfter('arrest agency');
    // arrestRow: [ArrestAgency, Officer, LocationOfArrest, SerialNumber]

    // ── Charges — parse each charge block ────────────────────
    // Structure: Warrant row → Case row → header row → data rows → Disposition → Bond Amount → Bond Status
    const charges = [];
    const allRows = Array.from(document.querySelectorAll('tr'));
    let inChargeSection = false;
    let inChargeData    = false;
    let currentCharge   = null;

    // Header labels to skip
    const skipLabels = new Set([
      'offense date','code section','description','type','counts','bond',
      'warrant','case','otn','disposition','bond amount','bond status',
      'charges','n/a','',
    ]);

    for (let ri = 0; ri < allRows.length; ri++) {
      const row   = allRows[ri];
      const cells = Array.from(row.querySelectorAll('td, th')).map(c => (c.innerText || '').trim());
      const text  = cells.join('|').toLowerCase();

      // Enter charges section
      if (!inChargeSection && text.includes('charges') && !text.includes('bond')) {
        inChargeSection = true;
        continue;
      }

      if (!inChargeSection) continue;

      // Exit charges section at Release Information
      if (text.includes('release information') || text.includes('attorney')) break;

      // Warrant line: "Warrant | 24-WD-NA46 | Warrant Date | 2/13/2026 | 1"
      if (text.includes('warrant') && !text.includes('case') && cells[0]?.toLowerCase() === 'warrant') {
        if (currentCharge) charges.push(currentCharge);
        currentCharge = {
          warrant:       cells[1] || '',
          warrant_date:  cells[3] || '',
          warrant_count: cells[4] || '',
          case_number:   '',
          otn:           '',
          offense_date:  '',
          code_section:  '',
          description:   '',
          type:          '',
          counts:        '',
          bond:          '',
          disposition:   '',
          bond_amount:   '',
          bond_status:   '',
        };
        inChargeData = false;
        continue;
      }

      // Case line: "Case | 24CR02977-AGP | OTN | [value]"
      if (cells[0]?.toLowerCase() === 'case' && currentCharge) {
        currentCharge.case_number = cells[1] || '';
        currentCharge.otn         = cells[3] || '';
        continue;
      }

      // Column headers line: "Offense Date | Code Section | Description | Type | Counts | Bond"
      if (text.includes('offense date') && text.includes('code section')) {
        inChargeData = true;
        continue;
      }

      // Charge data row
      if (inChargeData && currentCharge && cells.length >= 3) {
        const desc = cells[2] || '';
        if (desc && !skipLabels.has(desc.toLowerCase()) && desc.toLowerCase() !== 'n/a') {
          currentCharge.offense_date  = cells[0] || currentCharge.offense_date;
          currentCharge.code_section  = cells[1] || currentCharge.code_section;
          currentCharge.description   = desc;
          currentCharge.type          = cells[3] || '';
          currentCharge.counts        = cells[4] || '';
          currentCharge.bond          = cells[5] || '';
          inChargeData = false; // one charge row per block typically
        }
        continue;
      }

      // Disposition line
      if (cells[0]?.toLowerCase() === 'disposition' && currentCharge) {
        currentCharge.disposition = cells[1] || '';
        continue;
      }

      // Bond Amount line
      if (text.includes('bond amount') && currentCharge) {
        // "Bond Amount | $0.00"  — the amount is typically the last non-empty cell
        const amount = cells.filter(c => c && c !== 'Bond Amount').pop() || '';
        currentCharge.bond_amount = amount;
        continue;
      }

      // Bond Status line: "  | Bond Status | Sentenced/NO BOND |  | $0.00"
      if (text.includes('bond status') && currentCharge) {
        const idx = cells.findIndex(c => c.toLowerCase() === 'bond status');
        currentCharge.bond_status = cells[idx + 1] || '';
        continue;
      }
    }
    if (currentCharge) charges.push(currentCharge);

    // ── Release Information ───────────────────────────────────
    const releaseRow = rowAfter('release date');
    // Check "Not Released" text
    const isReleased = bodyText.includes('not released') ? false : true;

    // ── Height formatting: "508" → "5'08"" ───────────────────
    let height = physicalRow[0] || '';
    if (/^\d{3,4}$/.test(height)) {
      const h = height.padStart(3, '0');
      height  = `${h[0]}'${h.slice(1)}"`;
    }

    // ── Race/Sex split: "B /M" → race="B", sex="M" ───────────
    const raceSex = (personalRow[2] || '').replace(/\s/g, '');
    const [raceCode, sexCode] = raceSex.split('/');

    return {
      // Booking
      agency_id:        bookingRow[0] || '',
      arrest_date_time: bookingRow[1] || '',
      booking_started:  bookingRow[2] || '',
      booking_complete: bookingRow[3] || '',
      // Personal
      full_name:        personalRow[0] || '',
      dob:              personalRow[1] || '',
      race_code:        raceCode || '',
      sex_code:         sexCode  || '',
      location:         personalRow[3] || '',
      soid:             personalRow[4] || '',
      days_in_custody:  personalRow[5] || '',
      // Physical
      height,
      weight:           physicalRow[1] || '',
      hair:             physicalRow[2] || '',
      eyes:             physicalRow[3] || '',
      // Address
      address:          addressRow[0] || '',
      city:             addressRow[1] || '',
      state:            addressRow[2] || '',
      zip:              addressRow[3] || '',
      place_of_birth:   cellAfter('place of birth'),
      // Arrest
      arresting_agency: arrestRow[0] || '',
      arrest_officer:   arrestRow[1] || '',
      location_of_arrest: arrestRow[2] || '',
      serial_number:    arrestRow[3] || '',
      // Charges array
      charges,
      // Release
      release_date:     releaseRow[0] || '',
      release_officer:  releaseRow[1] || '',
      released_to:      releaseRow[2] || '',
      is_released:      isReleased && !bodyText.includes('not released'),
      attorney:         bodyText.includes('no attorney of record') ? '' : cellAfter('attorney'),
    };
  });
}

// ─────────────────────────────────────────────────────────────
// BUILD final record (normalise codes → full words)
// ─────────────────────────────────────────────────────────────
const RACE_MAP = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };

function buildRecord(detail, summaryRow, originalName) {
  const race = RACE_MAP[detail.race_code] || detail.race_code || RACE_MAP[summaryRow.race] || summaryRow.race || '';
  const sex  = detail.sex_code === 'M' ? 'Male' : detail.sex_code === 'F' ? 'Female' : detail.sex_code || summaryRow.sex || '';

  const chargesDesc = detail.charges.map(c => c.description).filter(Boolean).join('; ');
  const chargeType  = [...new Set(detail.charges.map(c => {
    const t = (c.type || '').toLowerCase();
    if (t.includes('felony'))     return 'Felony';
    if (t.includes('misdemeanor')) return 'Misdemeanor';
    return c.type;
  }).filter(Boolean))].join('; ');

  const rawSoid = (detail.soid || summaryRow.soid || '').trim();
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';

  // Bond info from first charge
  const firstCharge = detail.charges[0] || {};

  return {
    event_id:           eventId,
    full_name:          detail.full_name || summaryRow.name || '',
    original_name:      originalName || '',
    county:             'Cobb',

    // Booking
    agency_id:          detail.agency_id,
    arrest_date_time:   detail.arrest_date_time,
    booking_date:       detail.booking_started,
    end_of_booking_date: detail.booking_complete,
    booking_number:     detail.serial_number,

    // Demographics
    date_of_birth:      detail.dob || summaryRow.dob || '',
    race,
    sex,
    height:             detail.height,
    weight:             detail.weight,
    hair:               detail.hair,
    eyes:               detail.eyes,

    // Address
    address:            [detail.address, detail.city, detail.state, detail.zip].filter(Boolean).join(', '),
    place_of_birth:     detail.place_of_birth,

    // Custody
    custody_status:     detail.location || summaryRow.location || '',
    is_released:        detail.is_released,
    days_in_custody:    detail.days_in_custody || summaryRow.days_in_custody || '',
    release_date:       detail.release_date,
    release_officer:    detail.release_officer,
    released_to:        detail.released_to,

    // Arrest
    arresting_agency:   detail.arresting_agency,
    arrest_officer:     detail.arrest_officer,
    location_of_arrest: detail.location_of_arrest,

    // Charges
    charges:            chargesDesc,
    charge_type:        chargeType,
    charges_detail:     detail.charges,

    // Bond (from first charge block)
    bonding_amount:     firstCharge.bond_amount || '',
    bond_status:        firstCharge.bond_status || '',
    bonding_company:    '',   // not on page
    bondsman_name:      '',   // not on page

    // Legal
    warrant:            firstCharge.warrant || '',
    case_number:        firstCharge.case_number || '',
    otn:                firstCharge.otn || '',
    disposition:        firstCharge.disposition || '',
    attorney:           detail.attorney,

    processed:          false,
    locked:             false,
    scraped_at:         new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// /health
// ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const r = await getSessionCookie();
    res.json({ status: 'ok', proxy: `${PROXY_HOST}:${PROXY_PORT}`, site_reachable: true, cookies: r.cookies.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ status: 'degraded', error: err.message, proxy: `${PROXY_HOST}:${PROXY_PORT}`, hint: 'Update PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS in Railway Variables', timestamp: new Date().toISOString() });
  }
});

// ─────────────────────────────────────────────────────────────
// /proxy-test — raw diagnostic, call this first when broken
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// /scrape  POST { name: "Garcia, Elvia Yadira" }
//       or POST { name: "GARCIA ELVIA" }
//       or POST { soid: "001115049" }
// ─────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;
  if (!name && !soid) return res.status(400).json({ success: false, error: 'Provide name or soid' });

  const searchName = name ? formatName(name) : '';
  console.log(`\n[scrape] ── START "${name || soid}" → search:"${searchName}" ──`);

  let browser;
  try {
    browser = await launchBrowser();

    // ── Step 1: Session cookie ────────────────────────────────
    console.log('[scrape] Step 1 — session cookie');
    const session = await withRetry(() => getSessionCookie(), 3, 3000);
    let cookies = session.cookies;

    // ── Step 2: Submit search form ────────────────────────────
    console.log('[scrape] Step 2 — submit search (qry=Inquiry)');
    const searchResult = await withRetry(() => submitSearch(cookies, searchName, soid), 2, 2000);
    cookies = searchResult.cookies;

    // Follow redirect if server sends one
    let resultsHtml = searchResult.body;
    if (searchResult.status === 301 || searchResult.status === 302) {
      const loc = searchResult.location || '';
      const dest = loc.startsWith('http') ? loc : BASE_URL + loc;
      console.log(`[scrape] redirect → ${dest}`);
      const redir = await getPage(dest, cookies, BASE_URL + '/inquiry.asp');
      resultsHtml = redir.body;
      cookies     = redir.cookies;
    }
    console.log(`[scrape] results HTML: ${resultsHtml.length} chars`);

    // ── Step 3: Parse results page ────────────────────────────
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
    console.log(`[scrape] Found ${rows.length} result row(s): ${JSON.stringify(rows.map(r => r.name))}`);

    if (!rows.length) {
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    // Use the first matching row
    const summaryRow = rows[0];
    console.log(`[scrape] Using: "${summaryRow.name}" SOID:${summaryRow.soid} BookingID:${summaryRow.booking_id}`);

    // If no BOOKING_ID found, return summary only
    if (!summaryRow.booking_id && !summaryRow.detail_url) {
      console.log('[scrape] No BOOKING_ID — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, detail: false, data: buildSummaryRecord(summaryRow, name || soid) });
    }

    // ── Step 4: Fetch detail page ─────────────────────────────
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

    // ── Step 5: Parse detail page ─────────────────────────────
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

// Summary-only record (when detail page unavailable)
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

// ─────────────────────────────────────────────────────────────
// /admissions  GET — list today's admissions
// ─────────────────────────────────────────────────────────────
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
