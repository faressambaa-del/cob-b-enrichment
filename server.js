const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// Railway networking is set to Port 3000
const PORT = process.env.PORT || 3000;

// CORRECT URL — http only, no https
const BASE_URL = 'http://inmate-search.cobbsheriff.org';

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'cobb-county-scraper',
    port: PORT,
    region: 'US East Virginia',
    base_url: BASE_URL,
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// FORMAT NAME FOR COBB COUNTY SEARCH
// Input:  "Garcia, Elvia Yadira"  →  Output: "GARCIA ELVIA"
// Input:  "RANKIN SHAWN MARCUS"   →  Output: "RANKIN SHAWN"
// Cobb County NAME field: Last name (space) first name
// ─────────────────────────────────────────────────────────────
function formatName(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (raw.includes(',')) {
    const parts = raw.split(',');
    const last  = parts[0].trim();
    const first = parts[1].trim().split(' ')[0];
    return `${last} ${first}`.toUpperCase();
  }
  // Already "LAST FIRST" or similar — return uppercase
  return raw.toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// LAUNCH BROWSER
// No proxy needed — US East Virginia → Georgia is direct
// ─────────────────────────────────────────────────────────────
async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--ignore-certificate-errors',
      '--allow-running-insecure-content'
    ]
  });
}

// ─────────────────────────────────────────────────────────────
// SCRAPE ENDPOINT
// POST /scrape  { "name": "Garcia, Elvia Yadira" }
//               { "name": "RANKIN SHAWN" }
//               { "soid": "001115049" }
//
// EXACT FLOW (based on Cobb County site screenshots):
//   1. Load http://inmate-search.cobbsheriff.org
//   2. Fill NAME field → "LAST FIRST" format
//   3. Set dropdown to Inquiry
//   4. Click Search button
//   5. Read results table (Name|DOB|Race|Sex|Location|SOID|Days|Booking)
//   6. Click Last Known Booking button
//   7. Parse full detail page — all sections
//   8. Return structured JSON matching inmate_details Supabase schema
// ─────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;

  if (!name && !soid) {
    return res.status(400).json({ success: false, error: 'Provide name or soid' });
  }

  const searchName = name ? formatName(name) : '';
  console.log(`[scrape] ▶ name="${name || soid}" → formatted="${searchName}"`);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language':           'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    });

    // Set generous default timeouts
    page.setDefaultTimeout(300000);
    page.setDefaultNavigationTimeout(300000);

    // ── STEP 1: Jump directly to results URL ─────────────────
    // The homepage (BASE_URL /) times out from Railway because the
    // old ASP server drops non-browser connections on the root path.
    // Sub-page URLs work fine — this is exactly what the browser
    // submits after you click Search on enter_name.shtm.
    const searchParam = soid
      ? `soid=${encodeURIComponent(soid)}&inmate_name=&serial=&qry=Inquiry`
      : `soid=&inmate_name=${encodeURIComponent(searchName).replace(/%20/g, '+')}&serial=&qry=Inquiry`;
    const resultsUrl = `${BASE_URL}/inquiry.asp?${searchParam}`;

    console.log(`[scrape] GET ${resultsUrl}`);
    await page.goto(resultsUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    });
    console.log(`[scrape] Results loaded → ${page.url()}`);

    // ── STEP 5: Check for results ─────────────────────────────
    const bodyText = await page.textContent('body');
    const hasTable = (await page.$('table')) !== null;

    if (!hasTable ||
        bodyText.toLowerCase().includes('no record') ||
        bodyText.toLowerCase().includes('no match') ||
        bodyText.toLowerCase().includes('0 record')) {
      console.log(`[scrape] No results found`);
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    // Parse summary row
    // Columns: Image | Name | DOB | Race | Sex | Location | SOID | Days | Last Known Booking | Previous
    const summaryRow = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length >= 7 && cells[1] && cells[1].length > 2 &&
            !cells[1].toLowerCase().includes('name')) {
          return {
            name:            cells[1] || '',
            dob:             cells[2] || '',
            race:            cells[3] || '',
            sex:             cells[4] || '',
            location:        cells[5] || '',
            soid:            cells[6] || '',
            days_in_custody: cells[7] || ''
          };
        }
      }
      return null;
    });

    if (!summaryRow) {
      console.log(`[scrape] Could not parse results table`);
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    console.log(`[scrape] Found: "${summaryRow.name}" | SOID: ${summaryRow.soid} | Location: ${summaryRow.location}`);

    // ── STEP 6: Navigate to Last Known Booking detail page ───
    // The "Last Known Booking" button is a styled <input type="submit"> inside a
    // <form> that POSTs to InmDetails.asp with hidden soid + BOOKING_ID fields.
    // We extract those hidden values and construct the GET URL directly.
    // This is more reliable than clicking because Railway headless sometimes
    // fails to resolve form POSTs on old ASP pages.

    const detailUrl = await page.evaluate((baseUrl) => {
      // Strategy 1: find a <form> whose action contains InmDetails
      const forms = Array.from(document.querySelectorAll('form'));
      for (const form of forms) {
        const action = (form.action || form.getAttribute('action') || '').toLowerCase();
        if (action.includes('inmdetails') || action.includes('inm_details') || action.includes('booking')) {
          const soidInput    = form.querySelector('input[name="soid"], input[name="SOID"]');
          const bookingInput = form.querySelector('input[name="BOOKING_ID"], input[name="booking_id"]');
          if (soidInput && bookingInput) {
            return baseUrl + '/InmDetails.asp?soid=' + encodeURIComponent(soidInput.value) + '&BOOKING_ID=' + encodeURIComponent(bookingInput.value);
          }
          if (form.action && form.action.includes('InmDetails')) return form.action;
        }
      }
      // Strategy 2: any <a> linking to InmDetails
      const links = Array.from(document.querySelectorAll('a[href*="InmDetails"], a[href*="inm"]'));
      if (links.length > 0) return links[0].href;
      // Strategy 3: any submit button with booking text, grab its form
      const inputs = Array.from(document.querySelectorAll('input[type="submit"]'));
      for (const inp of inputs) {
        const val = (inp.value || '').toLowerCase();
        if (val.includes('booking') || val.includes('last known') || val.includes('detail')) {
          const form = inp.closest('form');
          if (form) {
            const soidInput    = form.querySelector('input[name="soid"], input[name="SOID"]');
            const bookingInput = form.querySelector('input[name="BOOKING_ID"], input[name="booking_id"]');
            if (soidInput && bookingInput) {
              return baseUrl + '/InmDetails.asp?soid=' + encodeURIComponent(soidInput.value) + '&BOOKING_ID=' + encodeURIComponent(bookingInput.value);
            }
            if (form.action) return form.action;
          }
        }
      }
      // Debug: log all forms
      const debug = forms.map(f => f.action + ' | ' + Array.from(f.querySelectorAll('input')).map(i => i.name+'='+i.value).join(','));
      console.log('NO_DETAIL_FORM:' + debug.join(' || '));
      return null;
    }, BASE_URL);

    if (!detailUrl) {
      // Fallback: use SOID alone — the site returns the latest booking for a given SOID
      const fallbackSoid = (summaryRow.soid || '').replace(/\D/g, '').trim();
      if (fallbackSoid) {
        const fallback = BASE_URL + '/InmDetails.asp?soid=' + encodeURIComponent(fallbackSoid) + '&BOOKING_ID=';
        console.log('[scrape] No booking form found — SOID fallback: ' + fallback);
        await page.goto(fallback, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } else {
        console.log('[scrape] Cannot resolve detail URL — returning summary only');
        await browser.close();
        return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
      }
    } else {
      console.log('[scrape] Navigating to detail: ' + detailUrl);
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }

    const detailFinalUrl = page.url();
    console.log('[scrape] Detail loaded → ' + detailFinalUrl);

    // ── STEP 7: Parse full detail page ───────────────────────
    // Sections: Booking Info | Personal | Physical | Address |
    //           Arrest Circumstances | Charges | Bond | Release
    const detail = await page.evaluate(() => {
      const allRows = Array.from(document.querySelectorAll('table tr'))
        .map(tr => Array.from(tr.querySelectorAll('td, th')).map(td => td.innerText.trim()))
        .filter(r => r.some(c => c.length > 0));

      const cv = (r, col) => ((allRows[r] || [])[col] || '').trim();

      function findRow(label) {
        for (let i = 0; i < allRows.length; i++) {
          if ((allRows[i][0] || '').toLowerCase() === label.toLowerCase()) return i;
        }
        return -1;
      }
      function findRowP(label) {
        for (let i = 0; i < allRows.length; i++) {
          if ((allRows[i][0] || '').toLowerCase().includes(label.toLowerCase())) return i;
        }
        return -1;
      }
      function findCell(label) {
        for (let i = 0; i < allRows.length; i++) {
          for (let j = 0; j < (allRows[i] || []).length; j++) {
            if ((allRows[i][j] || '').toLowerCase() === label.toLowerCase())
              return { r: i, c: j };
          }
        }
        return null;
      }
      function findCellP(label) {
        for (let i = 0; i < allRows.length; i++) {
          for (let j = 0; j < (allRows[i] || []).length; j++) {
            if ((allRows[i][j] || '').toLowerCase().includes(label.toLowerCase()))
              return { r: i, c: j };
          }
        }
        return null;
      }

      // ── Booking Information ──────────────────────────────────
      const bHdr = findRow('Agency ID');
      const bDat = bHdr >= 0 ? bHdr + 1 : -1;
      const agencyId        = bDat >= 0 ? cv(bDat, 0) : '';
      const arrestDateTime  = bDat >= 0 ? cv(bDat, 1) : '';
      const bookingStarted  = bDat >= 0 ? cv(bDat, 2) : '';
      const bookingComplete = bDat >= 0 ? cv(bDat, 3) : '';

      // ── Personal Information ─────────────────────────────────
      const pHdr = findRow('Name');
      const pDat = pHdr >= 0 ? pHdr + 1 : -1;
      const fullName      = pDat >= 0 ? cv(pDat, 0) : '';
      const dob           = pDat >= 0 ? cv(pDat, 1) : '';
      const raceSex       = pDat >= 0 ? cv(pDat, 2) : '';
      const location      = pDat >= 0 ? cv(pDat, 3) : '';
      const soidVal       = pDat >= 0 ? cv(pDat, 4) : '';
      const daysInCustody = pDat >= 0 ? cv(pDat, 5) : '';

      // ── Physical ─────────────────────────────────────────────
      const physHdr = findRow('Height');
      const physDat = physHdr >= 0 ? physHdr + 1 : -1;
      let height    = physDat >= 0 ? cv(physDat, 0) : '';
      const weight  = physDat >= 0 ? cv(physDat, 1) : '';
      const hair    = physDat >= 0 ? cv(physDat, 2) : '';
      const eyes    = physDat >= 0 ? cv(physDat, 3) : '';
      if (/^\d{3,4}$/.test(height)) {
        const h = height.padStart(3, '0');
        height = `${h[0]}'${h.slice(1)}"`;
      }

      // ── Address ──────────────────────────────────────────────
      const aHdr       = findRow('Address');
      const aDat       = aHdr >= 0 ? aHdr + 1 : -1;
      const addrStreet = aDat >= 0 ? cv(aDat, 0) : '';
      const addrCity   = aDat >= 0 ? cv(aDat, 1) : '';
      const addrState  = aDat >= 0 ? cv(aDat, 2) : '';
      const addrZip    = aDat >= 0 ? cv(aDat, 3) : '';
      const address    = [addrStreet, addrCity, addrState, addrZip].filter(Boolean).join(', ');

      // ── Place of Birth ────────────────────────────────────────
      const pobHdr       = findRow('Place of Birth');
      const placeOfBirth = pobHdr >= 0 ? cv(pobHdr, 1) : '';

      // ── Arrest Circumstances ─────────────────────────────────
      const arHdr         = findRow('Arrest Agency');
      const arDat         = arHdr >= 0 ? arHdr + 1 : -1;
      const arrestAgency  = arDat >= 0 ? cv(arDat, 0) : '';
      const arrestOfficer = arDat >= 0 ? cv(arDat, 1) : '';
      const locOfArrest   = arDat >= 0 ? cv(arDat, 2) : '';
      const serialNumber  = arDat >= 0 ? cv(arDat, 3) : '';

      // ── Warrant / Case ────────────────────────────────────────
      const wCell   = findCell('Warrant');
      const warrant = wCell ? cv(wCell.r, wCell.c + 1) : '';
      const csCell  = findCell('Case');
      const caseNum = csCell ? cv(csCell.r, csCell.c + 1) : '';
      const oCell   = findCell('OTN');
      const otn     = oCell ? cv(oCell.r, oCell.c + 1) : '';

      // ── Charges (multiple rows) ───────────────────────────────
      const chHdr   = findRow('Offense Date');
      const baHdr   = findRow('Bond Amount');
      const charges = [];
      if (chHdr >= 0) {
        const end = baHdr >= 0 ? baHdr : chHdr + 25;
        for (let r = chHdr + 1; r < end; r++) {
          const row  = allRows[r] || [];
          const desc = (row[2] || '').trim();
          if (desc && desc.toLowerCase() !== 'n/a' && desc.length > 2 &&
              !['offense date','description','type','warrant','case'].includes(desc.toLowerCase())) {
            charges.push({
              offense_date: (row[0] || '').trim(),
              code_section: (row[1] || '').trim(),
              description:  desc,
              type:         (row[3] || '').trim(),
              counts:       (row[4] || '').trim(),
              bond:         (row[5] || '').trim()
            });
          }
        }
      }
      const chargesDesc = charges.map(ch => ch.description).join('; ');
      const chargeTypes = [...new Set(charges.map(ch => {
        if (ch.type.toLowerCase().includes('felony'))      return 'Felony';
        if (ch.type.toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
        return ch.type;
      }).filter(Boolean))].join('; ');

      // ── Disposition ───────────────────────────────────────────
      const dispCell    = findCell('Disposition');
      const disposition = dispCell ? cv(dispCell.r, dispCell.c + 1) : '';

      // ── Bond ──────────────────────────────────────────────────
      const baCell     = findCell('Bond Amount');
      const totalBond  = baCell ? cv(baCell.r, baCell.c + 1) : '';
      const bsCell     = findCellP('Bond Status');
      const bondStatus = bsCell ? cv(bsCell.r, bsCell.c + 1) : '';
      const bondingCo  = bsCell ? cv(bsCell.r, bsCell.c + 2) : '';

      // ── Bondsman / Case-Warrant ───────────────────────────────
      const cwCell     = findCellP('Case/Warrant');
      let caseWarrant  = '';
      let bondsmanName = '';
      if (cwCell) {
        caseWarrant  = cv(cwCell.r + 1, cwCell.c);
        bondsmanName = cv(cwCell.r + 1, cwCell.c + 1);
      }

      // ── Attorney ──────────────────────────────────────────────
      const bodyText   = document.body.innerText || '';
      const noAttorney = bodyText.includes('No Attorney of Record');
      const attHdr     = findRowP('Attorney');
      const attorney   = noAttorney ? '' : (attHdr >= 0 ? cv(attHdr + 1, 0) : '');

      // ── Release Information ───────────────────────────────────
      const relHdr         = findRow('Release Date');
      const relDat         = relHdr >= 0 ? relHdr + 1 : -1;
      const releaseDate    = relDat >= 0 ? cv(relDat, 0) : '';
      const releaseOfficer = relDat >= 0 ? cv(relDat, 1) : '';
      const releasedTo     = relDat >= 0 ? cv(relDat, 2) : '';
      const notReleased    = bodyText.includes('Not Released');
      const isReleased     = !notReleased && !location.toLowerCase().includes('jail');

      return {
        agency_id: agencyId, arrest_date_time: arrestDateTime,
        booking_started: bookingStarted, booking_complete: bookingComplete,
        full_name: fullName, dob, race_sex: raceSex, location,
        soid: soidVal, days_in_custody: daysInCustody,
        height, weight, hair, eyes,
        address, place_of_birth: placeOfBirth,
        arresting_agency: arrestAgency, arrest_officer: arrestOfficer,
        location_of_arrest: locOfArrest, serial_number: serialNumber,
        charges, charges_description: chargesDesc, charge_type: chargeTypes,
        warrant, case_number: caseNum, otn, case_warrant: caseWarrant,
        bonding_amount: totalBond, bond_status: bondStatus,
        bonding_company: bondingCo, bondsman_name: bondsmanName,
        disposition, attorney,
        release_date: releaseDate, release_officer: releaseOfficer,
        released_to: releasedTo, is_released: isReleased
      };
    });

    await browser.close();

    // Parse race/sex split e.g. "B/M" → race=Black, sex=Male
    const rsp     = (detail.race_sex || '').split('/');
    const raceMap = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
    const race    = raceMap[rsp[0]?.trim()] || rsp[0]?.trim() || summaryRow.race || '';
    const sexRaw  = rsp[1]?.trim() || summaryRow.sex || '';
    const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;

    // Normalize SOID to integer string
    const rawSoid = detail.soid || summaryRow.soid || '';
    const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';

    // Build data object matching inmate_details Supabase schema exactly
    const data = {
      event_id:            eventId,
      full_name:           detail.full_name || summaryRow.name || '',
      original_name:       name || '',
      charges:             detail.charges_description || '',
      charge_type:         detail.charge_type || '',
      county:              'Cobb',
      custody_status:      detail.location || summaryRow.location || '',
      is_released:         detail.is_released,           // boolean
      bonding_amount:      detail.bonding_amount || '',
      bonding_company:     detail.bonding_company || '',
      booking_date:        detail.booking_started || '',
      end_of_booking_date: detail.booking_complete || '',
      booking_number:      detail.serial_number || '',
      address:             detail.address || '',
      arresting_agency:    detail.arresting_agency || '',
      arrest_officer:      detail.arrest_officer || '',
      days_in_custody:     detail.days_in_custody || summaryRow.days_in_custody || '',
      place_of_birth:      detail.place_of_birth || '',
      date_of_birth:       detail.dob || summaryRow.dob || '',
      attorney:            detail.attorney || '',
      bondsman_name:       detail.bondsman_name || '',
      case_warrant:        detail.case_warrant || '',
      bond_status:         detail.bond_status || '',
      race,
      sex,
      height:              detail.height || '',
      weight:              detail.weight || '',
      hair:                detail.hair || '',
      eyes:                detail.eyes || '',
      processed:           false,
      locked:              false,
      scraped_at:          new Date().toISOString(),
      // Extra fields
      warrant:             detail.warrant || '',
      case_number:         detail.case_number || '',
      otn:                 detail.otn || '',
      disposition:         detail.disposition || '',
      arrest_date_time:    detail.arrest_date_time || '',
      agency_id:           detail.agency_id || '',
      charges_detail:      detail.charges || []
    };

    console.log(`[scrape] ✅ ${data.full_name} | event_id: ${data.event_id} | released: ${data.is_released} | charges: ${data.charges.substring(0, 60)}`);

    return res.json({
      success:     true,
      found:       true,
      search_name: name || soid || '',
      detail_url:  detailFinalUrl,
      scraped_at:  new Date().toISOString(),
      data
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[scrape] ❌ "${name || soid}": ${err.message}`);
    return res.status(500).json({
      success: false,
      found:   false,
      error:   err.message,
      name:    name || soid || ''
    });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMISSIONS ENDPOINT
// POST /admissions — scrapes Admissions tab for new bookings list
// ─────────────────────────────────────────────────────────────
app.post('/admissions', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    // Skip homepage — go directly to admissions results
    const admUrl = `${BASE_URL}/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions`;
    console.log('[admissions] GET ' + admUrl);
    await page.goto(admUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('table', { timeout: 30000 });

    const inmates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (!cells[1] || cells[1].length < 2) return null;
        return {
          name:            cells[1] || '',
          dob:             cells[2] || '',
          race:            cells[3] || '',
          sex:             cells[4] || '',
          location:        cells[5] || '',
          soid:            cells[6] || '',
          days_in_custody: cells[7] || ''
        };
      }).filter(Boolean);
    });

    await browser.close();
    res.json({ success: true, count: inmates.length, inmates });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[admissions] ❌', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// HELPER — basic data from summary row only
// Used when detail page navigation fails
// ─────────────────────────────────────────────────────────────
function buildBasicData(summaryRow, originalName) {
  const rawSoid = summaryRow.soid || '';
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';
  const raceMap = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
  const race    = raceMap[(summaryRow.race || '').trim()] || summaryRow.race || '';
  const sexRaw  = (summaryRow.sex || '').trim();
  const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;
  return {
    event_id:        eventId,
    full_name:       summaryRow.name || '',
    original_name:   originalName || '',
    charges:         '',
    charge_type:     '',
    county:          'Cobb',
    custody_status:  summaryRow.location || '',
    is_released:     (summaryRow.location || '').toUpperCase() === 'RELEASED',
    bonding_amount:  '',
    bonding_company: '',
    booking_date:    '',
    date_of_birth:   summaryRow.dob || '',
    days_in_custody: summaryRow.days_in_custody || '',
    race,
    sex,
    processed:       false,
    locked:          false,
    scraped_at:      new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Cobb County Scraper running on port ${PORT}`);
  console.log(`   BASE_URL: ${BASE_URL}`);
  console.log(`   Region:   US East (Virginia)`);
});
