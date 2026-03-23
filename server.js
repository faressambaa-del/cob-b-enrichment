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

    // ── STEP 1: Establish session via enter_name.shtm ───────
    // The site uses ASP session cookies. Without a valid session,
    // the results page loads but all form actions and booking links
    // are stripped — that's why forms=[] and BOOKING_ID is missing.
    // Fix: visit the search form page first to get a session cookie,
    // then submit the form properly so the results page is fully hydrated.

    const searchFormUrl = BASE_URL + '/enter_name.shtm';
    console.log('[scrape] Establishing session: ' + searchFormUrl);
    await page.goto(searchFormUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('[scrape] Session page loaded → ' + page.url());

    // Fill the NAME field and submit the form
    await page.fill('input[name="name"], input[name="NAME"], input[name="inmate_name"]',
      soid ? '' : searchName);
    if (soid) {
      await page.fill('input[name="soid"], input[name="SOID"]', soid).catch(() => {});
    }

    // Set dropdown to Inquiry
    await page.selectOption('select', { label: 'Inquiry' }).catch(async () => {
      await page.selectOption('select', 'Inquiry').catch(() => {});
    });

    console.log('[scrape] Submitting search form for: ' + searchName);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      page.click('input[value="Search"]')
    ]);
    console.log('[scrape] Results loaded → ' + page.url());

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

    // ── STEP 6: Click Last Known Booking with active session ─
    // Now that we have a real ASP session (established via form submit),
    // the results page is fully rendered with the booking form/links.
    // We try multiple strategies in order of reliability.

    let detailFinalUrl = '';

    // Log ALL elements for complete visibility
    const pageElements = await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action, method: f.method,
        inputs: Array.from(f.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, value: i.value }))
      }));
      const links = Array.from(document.querySelectorAll('a')).map(a => ({ text: (a.innerText||'').trim(), href: a.href, onclick: a.getAttribute('onclick')||'' }));
      const buttons = Array.from(document.querySelectorAll('input[type="submit"],button')).map(b => ({ value: b.value||b.innerText, onclick: b.getAttribute('onclick')||'', formAction: b.form ? b.form.action : '' }));
      return { forms, links, buttons };
    });
    console.log('[DEBUG] Page elements after session: ' + JSON.stringify(pageElements));

    // Strategy 1: <a href> containing InmDetails
    const inmLink = await page.$('a[href*="InmDetails"], a[href*="inmdetails"], a[href*="Inm"]');
    if (inmLink) {
      const href = await inmLink.getAttribute('href');
      console.log('[scrape] Strategy 1 — InmDetails <a>: ' + href);
      const fullUrl = href.startsWith('http') ? href : BASE_URL + '/' + href.replace(/^\//, '');
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      detailFinalUrl = page.url();

    // Strategy 2: form whose action contains InmDetails — extract hidden fields and POST
    } else if (pageElements.forms.some(f => (f.action||'').toLowerCase().includes('inmdetails'))) {
      const bookingForm = pageElements.forms.find(f => (f.action||'').toLowerCase().includes('inmdetails'));
      const bookingId  = (bookingForm.inputs.find(i => i.name.toUpperCase() === 'BOOKING_ID') || {}).value || '';
      const soidVal    = (bookingForm.inputs.find(i => i.name.toUpperCase() === 'SOID') || {}).value || summaryRow.soid;
      console.log('[scrape] Strategy 2 — form POST: soid=' + soidVal + ' BOOKING_ID=' + bookingId);
      const detailUrl = BASE_URL + '/InmDetails.asp?soid=' + encodeURIComponent(soidVal) + '&BOOKING_ID=' + encodeURIComponent(bookingId);
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      detailFinalUrl = page.url();

    // Strategy 3: submit button with booking text — click it with the session active
    } else {
      console.log('[scrape] Strategy 3 — clicking submit button with active session');
      try {
        // Match the exact "Last Known Booking" input submit button
        const btn = page.locator('input[type="submit"]').filter({ hasText: /booking/i }).first();
        const btnCount = await btn.count();
        if (btnCount > 0) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            btn.click()
          ]);
          detailFinalUrl = page.url();
        } else {
          // Last resort: click the first submit button in the results table
          const firstSubmit = page.locator('table input[type="submit"]').first();
          if (await firstSubmit.count() > 0) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
              firstSubmit.click()
            ]);
            detailFinalUrl = page.url();
          } else {
            console.log('[scrape] No booking button found — returning summary only');
            await browser.close();
            return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
          }
        }
      } catch (clickErr) {
        console.log('[scrape] Click error: ' + clickErr.message);
        await browser.close();
        return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
      }
    }

    console.log('[scrape] Detail loaded → ' + detailFinalUrl);

    if (!detailFinalUrl || detailFinalUrl.includes('Error_Page') || detailFinalUrl.includes('error_page')) {
      console.log('[scrape] Error page reached — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
    }

    // ── DEBUG: dump raw page HTML and innerText to diagnose blank fields ──
    const debugDump = await page.evaluate(() => {
      const allTds = Array.from(document.querySelectorAll('td, th'));
      const cellTexts = allTds.map((td, i) => i + ': [' + (td.innerText || '').trim().replace(/\n/g, '|') + ']');
      return {
        url:        window.location.href,
        title:      document.title,
        bodySnippet: (document.body.innerText || '').substring(0, 2000),
        tdCount:    allTds.length,
        cells:      cellTexts.slice(0, 80)   // first 80 cells
      };
    });
    console.log('[DEBUG] URL: ' + debugDump.url);
    console.log('[DEBUG] Title: ' + debugDump.title);
    console.log('[DEBUG] TD count: ' + debugDump.tdCount);
    console.log('[DEBUG] Body snippet: ' + debugDump.bodySnippet.replace(/\n/g, ' | ').substring(0, 500));
    console.log('[DEBUG] Cells: ' + debugDump.cells.join(' \n'));

    // ── STEP 7: Parse full detail page ───────────────────────
    // Root cause of empty fields: the page uses NESTED tables.
    // querySelectorAll('table tr') returns rows from ALL nested
    // tables mixed together, so row-index math breaks completely.
    // Fix: search cell-by-cell using innerText on individual <td>
    // elements, then grab the sibling/next-row cell for the value.
    const detail = await page.evaluate(() => {
      const body = document.body.innerText || '';

      // Core helper: find a <td> whose trimmed text exactly matches
      // label, then return the text of the next sibling <td> in the
      // same <tr>, OR the first <td> of the next <tr>.
      function getValueAfterLabel(label) {
        const tds = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < tds.length; i++) {
          const text = (tds[i].innerText || '').trim();
          if (text.toLowerCase() === label.toLowerCase()) {
            // Try next sibling td in same row first
            let sib = tds[i].nextElementSibling;
            while (sib) {
              if (sib.tagName === 'TD' || sib.tagName === 'TH') {
                const val = (sib.innerText || '').trim();
                if (val) return val;
              }
              sib = sib.nextElementSibling;
            }
            // Try first td of the next tr
            const tr = tds[i].closest('tr');
            if (tr) {
              const nextTr = tr.nextElementSibling;
              if (nextTr) {
                const firstTd = nextTr.querySelector('td, th');
                if (firstTd) return (firstTd.innerText || '').trim();
              }
            }
          }
        }
        return '';
      }

      // Like getValueAfterLabel but returns ALL sibling tds in the
      // next data row as an array — used for multi-column data rows.
      function getRowAfterLabel(label) {
        const tds = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < tds.length; i++) {
          const text = (tds[i].innerText || '').trim();
          if (text.toLowerCase() === label.toLowerCase()) {
            const tr = tds[i].closest('tr');
            if (tr) {
              const nextTr = tr.nextElementSibling;
              if (nextTr) {
                return Array.from(nextTr.querySelectorAll('td, th'))
                  .map(td => (td.innerText || '').trim());
              }
            }
          }
        }
        return [];
      }

      // ── Booking Information ──────────────────────────────────
      // Header row: Agency ID | Arrest Date/Time | Booking Started | Booking Complete
      const bookRow      = getRowAfterLabel('Agency ID');
      const agencyId        = bookRow[0] || '';
      const arrestDateTime  = bookRow[1] || '';
      const bookingStarted  = bookRow[2] || '';
      const bookingComplete = bookRow[3] || '';

      // ── Personal Information ─────────────────────────────────
      // Header row: Name | DOB | Race/Sex | Location | SOID | Days in Custody
      const persRow     = getRowAfterLabel('Name');
      const fullName      = persRow[0] || '';
      const dob           = persRow[1] || '';
      const raceSex       = persRow[2] || '';
      const location      = persRow[3] || '';
      const soidVal       = persRow[4] || '';
      const daysInCustody = persRow[5] || '';

      // ── Physical ─────────────────────────────────────────────
      // Header row: Height | Weight | Hair | Eyes
      const physRow = getRowAfterLabel('Height');
      let height    = physRow[0] || '';
      const weight  = physRow[1] || '';
      const hair    = physRow[2] || '';
      const eyes    = physRow[3] || '';
      // Convert raw height e.g. "500" -> "5'00\"", "508" -> "5'08\""
      if (/^\d{3,4}$/.test(height)) {
        const h = height.padStart(3, '0');
        height = h[0] + "'" + h.slice(1) + '"';
      }

      // ── Address ──────────────────────────────────────────────
      // Header row: Address | City | State | Zip
      const addrRow    = getRowAfterLabel('Address');
      const addrStreet = addrRow[0] || '';
      const addrCity   = addrRow[1] || '';
      const addrState  = addrRow[2] || '';
      const addrZip    = addrRow[3] || '';
      const address    = [addrStreet, addrCity, addrState, addrZip].filter(Boolean).join(', ');

      // ── Place of Birth ────────────────────────────────────────
      const placeOfBirth = getValueAfterLabel('Place of Birth');

      // ── Arrest Circumstances ─────────────────────────────────
      // Header row: Arrest Agency | Officer | Location of Arrest | Serial #
      const arrestRow     = getRowAfterLabel('Arrest Agency');
      const arrestAgency  = arrestRow[0] || '';
      const arrestOfficer = arrestRow[1] || '';
      const locOfArrest   = arrestRow[2] || '';
      const serialNumber  = arrestRow[3] || '';

      // ── Warrant / Case / OTN ─────────────────────────────────
      const warrant = getValueAfterLabel('Warrant');
      const caseNum = getValueAfterLabel('Case');
      const otn     = getValueAfterLabel('OTN');

      // ── Charges ───────────────────────────────────────────────
      // Find all rows between 'Offense Date' header and 'Bond Amount' section
      // Each charge row: Offense Date | Code Section | Description | Type | Counts | Bond
      const charges = [];
      const allTrs  = Array.from(document.querySelectorAll('tr'));
      let inCharges = false;
      for (const tr of allTrs) {
        const cells = Array.from(tr.querySelectorAll('td, th')).map(c => (c.innerText || '').trim());
        const rowText = cells.join('|').toLowerCase();
        if (!inCharges && rowText.includes('offense date') && rowText.includes('code section')) {
          inCharges = true;
          continue;
        }
        if (inCharges) {
          // Stop at Bond Amount or Release Information section headers
          if (rowText.includes('bond amount') || rowText.includes('release information') ||
              rowText.includes('release date') || rowText.includes('attorney')) break;
          const desc = cells[2] || '';
          if (desc && desc.toLowerCase() !== 'n/a' && desc.length > 2 &&
              !['offense date','description','type','warrant','case','disposition','counts','bond'].includes(desc.toLowerCase())) {
            charges.push({
              offense_date: cells[0] || '',
              code_section: cells[1] || '',
              description:  desc,
              type:         cells[3] || '',
              counts:       cells[4] || '',
              bond:         cells[5] || ''
            });
          }
        }
      }
      const chargesDesc  = charges.map(ch => ch.description).join('; ');
      const chargeTypes  = [...new Set(charges.map(ch => {
        if ((ch.type || '').toLowerCase().includes('felony'))      return 'Felony';
        if ((ch.type || '').toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
        return ch.type;
      }).filter(Boolean))].join('; ');

      // ── Disposition ───────────────────────────────────────────
      const disposition = getValueAfterLabel('Disposition');

      // ── Bond ─────────────────────────────────────────────────
      const bondRow    = getRowAfterLabel('Bond Status');
      const totalBond  = getValueAfterLabel('Bond Amount');
      const bondStatus = bondRow[1] || '';
      const bondingCo  = bondRow[2] || '';

      // ── Bondsman ─────────────────────────────────────────────
      const bondsmanRow  = getRowAfterLabel('Case/Warrant');
      const caseWarrant  = bondsmanRow[0] || '';
      const bondsmanName = bondsmanRow[1] || '';

      // ── Attorney ──────────────────────────────────────────────
      const noAttorney = body.includes('No Attorney of Record');
      const attorney   = noAttorney ? '' : getValueAfterLabel('Attorney');

      // ── Release Information ───────────────────────────────────
      const relRow         = getRowAfterLabel('Release Date');
      const releaseDate    = relRow[0] || '';
      const releaseOfficer = relRow[1] || '';
      const releasedTo     = relRow[2] || '';
      const notReleased    = body.includes('Not Released');
      const isReleased     = !notReleased && !(location || '').toLowerCase().includes('jail');

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
