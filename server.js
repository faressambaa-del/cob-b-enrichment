const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'cobb-county-scraper',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// HELPER — FORMAT NAME
// Gazette: "Garcia, Elvia Yadira" → "GARCIA ELVIA"
// Gazette: "RANKIN SHAWN MARCUS"  → "RANKIN SHAWN"
// ─────────────────────────────────────────────────────────────
function formatNameForSearch(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (raw.includes(',')) {
    const parts = raw.split(',');
    const last  = parts[0].trim();
    const first = parts[1].trim().split(' ')[0];
    return `${last} ${first}`.toUpperCase();
  }
  return raw.toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// HELPER — LAUNCH BROWSER
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
      '--single-process'
    ]
  });
}

// ─────────────────────────────────────────────────────────────
// SCRAPE ENDPOINT
// POST /scrape { name: "Garcia, Elvia Yadira" }
//              { name: "RANKIN SHAWN" }
//              { soid: "001115049" }
// ─────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;

  if (!name && !soid) {
    return res.status(400).json({ success: false, error: 'Provide name or soid' });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // ── STEP 1: Load search page ──────────────────────────────
    console.log(`[scrape] Searching: ${name || soid}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name="name"], input[name="NAME"]', { timeout: 20000 });

    // ── STEP 2: Fill form ─────────────────────────────────────
    if (soid) {
      const soidInput = await page.$('input[name="soid"], input[name="SOID"]');
      if (soidInput) await soidInput.fill(soid);
    }
    if (name) {
      const formatted = formatNameForSearch(name);
      console.log(`[scrape] Formatted: "${formatted}"`);
      const nameInput = await page.$('input[name="name"], input[name="NAME"]');
      if (nameInput) await nameInput.fill(formatted);
    }

    // ── STEP 3: Set dropdown to Inquiry ──────────────────────
    const select = await page.$('select');
    if (select) await select.selectOption({ label: 'Inquiry' });

    // ── STEP 4: Click Search ──────────────────────────────────
    const searchBtn = await page.$('input[value="Search"]');
    if (!searchBtn) throw new Error('Search button not found');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      searchBtn.click()
    ]);

    // ── STEP 5: Check results ─────────────────────────────────
    const bodyText = await page.textContent('body');
    const noResults =
      bodyText.toLowerCase().includes('no record') ||
      bodyText.toLowerCase().includes('no match') ||
      bodyText.toLowerCase().includes('0 record') ||
      !(await page.$('table'));

    if (noResults) {
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    // Read summary row
    const summaryRow = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length >= 7 && cells[1] && cells[1].length > 2) {
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
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    console.log(`[scrape] Found: ${summaryRow.name} | SOID: ${summaryRow.soid}`);

    // ── STEP 6: Click Last Known Booking ─────────────────────
    const bookingBtn = await page.$(
      'input[value="Last Known Booking"], input[value*="Last Known"], input[value*="Booking"]'
    );

    if (!bookingBtn) {
      await browser.close();
      return res.json({
        success: true,
        found: true,
        data: buildBasicData(summaryRow, name || soid)
      });
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      bookingBtn.click()
    ]);

    const detailUrl = page.url();
    console.log(`[scrape] Detail URL: ${detailUrl}`);

    // ── STEP 7: Scrape full detail page ───────────────────────
    const detail = await page.evaluate(() => {
      const allRows = Array.from(document.querySelectorAll('table tr'))
        .map(tr => Array.from(tr.querySelectorAll('td, th')).map(td => td.innerText.trim()))
        .filter(r => r.some(c => c.length > 0));

      const c = (r, col) => ((allRows[r] || [])[col] || '').trim();

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
            if ((allRows[i][j] || '').toLowerCase() === label.toLowerCase()) return { r: i, c: j };
          }
        }
        return null;
      }
      function findCellP(label) {
        for (let i = 0; i < allRows.length; i++) {
          for (let j = 0; j < (allRows[i] || []).length; j++) {
            if ((allRows[i][j] || '').toLowerCase().includes(label.toLowerCase())) return { r: i, c: j };
          }
        }
        return null;
      }

      // Booking Information
      const bHdr = findRow('Agency ID');
      const bDat = bHdr >= 0 ? bHdr + 1 : -1;
      const agencyId        = bDat >= 0 ? c(bDat, 0) : '';
      const arrestDateTime  = bDat >= 0 ? c(bDat, 1) : '';
      const bookingStarted  = bDat >= 0 ? c(bDat, 2) : '';
      const bookingComplete = bDat >= 0 ? c(bDat, 3) : '';

      // Personal Information
      const pHdr = findRow('Name');
      const pDat = pHdr >= 0 ? pHdr + 1 : -1;
      const fullName      = pDat >= 0 ? c(pDat, 0) : '';
      const dob           = pDat >= 0 ? c(pDat, 1) : '';
      const raceSex       = pDat >= 0 ? c(pDat, 2) : '';
      const location      = pDat >= 0 ? c(pDat, 3) : '';
      const soidVal       = pDat >= 0 ? c(pDat, 4) : '';
      const daysInCustody = pDat >= 0 ? c(pDat, 5) : '';

      // Physical
      const physHdr = findRow('Height');
      const physDat = physHdr >= 0 ? physHdr + 1 : -1;
      let height    = physDat >= 0 ? c(physDat, 0) : '';
      const weight  = physDat >= 0 ? c(physDat, 1) : '';
      const hair    = physDat >= 0 ? c(physDat, 2) : '';
      const eyes    = physDat >= 0 ? c(physDat, 3) : '';
      if (/^\d{3,4}$/.test(height)) {
        const h = height.padStart(3, '0');
        height = `${h[0]}'${h.slice(1)}"`;
      }

      // Address
      const aHdr       = findRow('Address');
      const aDat       = aHdr >= 0 ? aHdr + 1 : -1;
      const addrStreet = aDat >= 0 ? c(aDat, 0) : '';
      const addrCity   = aDat >= 0 ? c(aDat, 1) : '';
      const addrState  = aDat >= 0 ? c(aDat, 2) : '';
      const addrZip    = aDat >= 0 ? c(aDat, 3) : '';
      const address    = [addrStreet, addrCity, addrState, addrZip].filter(Boolean).join(', ');

      // Place of Birth
      const pobHdr       = findRow('Place of Birth');
      const placeOfBirth = pobHdr >= 0 ? c(pobHdr, 1) : '';

      // Arrest Circumstances
      const arHdr         = findRow('Arrest Agency');
      const arDat         = arHdr >= 0 ? arHdr + 1 : -1;
      const arrestAgency  = arDat >= 0 ? c(arDat, 0) : '';
      const arrestOfficer = arDat >= 0 ? c(arDat, 1) : '';
      const locOfArrest   = arDat >= 0 ? c(arDat, 2) : '';
      const serialNumber  = arDat >= 0 ? c(arDat, 3) : '';

      // Warrant / Case
      const wCell   = findCell('Warrant');
      const warrant = wCell ? c(wCell.r, wCell.c + 1) : '';
      const csCell  = findCell('Case');
      const caseNum = csCell ? c(csCell.r, csCell.c + 1) : '';
      const oCell   = findCell('OTN');
      const otn     = oCell ? c(oCell.r, oCell.c + 1) : '';

      // Charges
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
      const chargesDesc  = charges.map(ch => ch.description).join('; ');
      const chargeTypes  = [...new Set(charges.map(ch => {
        if (ch.type.toLowerCase().includes('felony'))      return 'Felony';
        if (ch.type.toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
        return ch.type;
      }).filter(Boolean))].join('; ');

      // Bond
      const baCell     = findCell('Bond Amount');
      const totalBond  = baCell ? c(baCell.r, baCell.c + 1) : '';
      const bsCell     = findCellP('Bond Status');
      const bondStatus = bsCell ? c(bsCell.r, bsCell.c + 1) : '';
      const bondingCo  = bsCell ? c(bsCell.r, bsCell.c + 2) : '';

      // Bondsman / Case-Warrant
      const cwCell     = findCellP('Case/Warrant');
      let caseWarrant  = '';
      let bondsmanName = '';
      if (cwCell) {
        caseWarrant  = c(cwCell.r + 1, cwCell.c);
        bondsmanName = c(cwCell.r + 1, cwCell.c + 1);
      }

      // Disposition
      const dispCell    = findCell('Disposition');
      const disposition = dispCell ? c(dispCell.r, dispCell.c + 1) : '';

      // Attorney
      const bodyText   = document.body.innerText || '';
      const noAttorney = bodyText.includes('No Attorney of Record');
      const attHdr     = findRowP('Attorney');
      const attorney   = noAttorney ? '' : (attHdr >= 0 ? c(attHdr + 1, 0) : '');

      // Release
      const relHdr         = findRow('Release Date');
      const relDat         = relHdr >= 0 ? relHdr + 1 : -1;
      const releaseDate    = relDat >= 0 ? c(relDat, 0) : '';
      const releaseOfficer = relDat >= 0 ? c(relDat, 1) : '';
      const releasedTo     = relDat >= 0 ? c(relDat, 2) : '';
      const notReleased    = bodyText.includes('Not Released');
      const isReleased     = !notReleased && !location.toLowerCase().includes('jail');

      return {
        agency_id: agencyId, arrest_date_time: arrestDateTime,
        booking_started: bookingStarted, booking_complete: bookingComplete,
        full_name: fullName, dob, race_sex: raceSex, location,
        soid: soidVal, days_in_custody: daysInCustody,
        height, weight, hair, eyes,
        address, address_street: addrStreet, address_city: addrCity,
        address_state: addrState, address_zip: addrZip,
        place_of_birth: placeOfBirth,
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

    // Parse race/sex
    const rsp     = (detail.race_sex || '').split('/');
    const raceMap = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
    const race    = raceMap[rsp[0]?.trim()] || rsp[0]?.trim() || summaryRow.race || '';
    const sexRaw  = rsp[1]?.trim() || summaryRow.sex || '';
    const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;

    // Normalize SOID
    const rawSoid = detail.soid || summaryRow.soid || '';
    const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g, ''), 10)) : '';

    const data = {
      event_id:            eventId,
      full_name:           detail.full_name || summaryRow.name || '',
      original_name:       name || '',
      charges:             detail.charges_description || '',
      charge_type:         detail.charge_type || '',
      county:              'Cobb',
      custody_status:      detail.location || summaryRow.location || '',
      is_released:         detail.is_released,
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
      race, sex,
      height:              detail.height || '',
      weight:              detail.weight || '',
      hair:                detail.hair || '',
      eyes:                detail.eyes || '',
      processed:           false,
      locked:              false,
      scraped_at:          new Date().toISOString(),
      warrant:             detail.warrant || '',
      case_number:         detail.case_number || '',
      otn:                 detail.otn || '',
      disposition:         detail.disposition || '',
      arrest_date_time:    detail.arrest_date_time || '',
      agency_id:           detail.agency_id || '',
      charges_detail:      detail.charges || []
    };

    console.log(`[scrape] ✅ ${data.full_name} | event_id: ${data.event_id} | charges: ${data.charges.substring(0, 60)}`);

    return res.json({
      success:     true,
      found:       true,
      search_name: name || soid || '',
      detail_url:  detailUrl,
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
// POST /admissions — scrapes Admissions tab for recent bookings
// ─────────────────────────────────────────────────────────────
app.post('/admissions', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const admBtn = await page.$('input[value="Admissions"], a:has-text("Admissions")');
    if (!admBtn) throw new Error('Admissions button not found');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      admBtn.click()
    ]);

    await page.waitForSelector('table', { timeout: 20000 });

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
// HELPER — Basic data from summary row only
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
    is_released:     !(summaryRow.location || '').toLowerCase().includes('jail'),
    bonding_amount:  '',
    bonding_company: '',
    booking_date:    '',
    date_of_birth:   summaryRow.dob || '',
    days_in_custody: summaryRow.days_in_custody || '',
    race, sex,
    processed:       false,
    locked:          false,
    scraped_at:      new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Cobb County Scraper running on port ${PORT}`);
});
