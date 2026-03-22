const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'cobb-scraper', timestamp: new Date().toISOString() });
});

// ─── ADMISSIONS SCRAPER ──────────────────────────────────────
// Scrapes the Admissions tab — returns list of recent bookings
app.post('/admissions', async (req, res) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.click('a:has-text("Admissions"), input[value="Admissions"], [href*="Admission"]');
    await page.waitForSelector('table', { timeout: 15000 });

    const inmates = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (!cells[1]) return null;
        return {
          name:           cells[1] || '',
          dob:            cells[2] || '',
          race:           cells[3] || '',
          sex:            cells[4] || '',
          location:       cells[5] || '',
          soid:           cells[6] || '',
          days_in_custody:cells[7] || '',
        };
      }).filter(Boolean);
    });

    await browser.close();
    res.json({ success: true, count: inmates.length, inmates });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Admissions error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── INMATE INQUIRY SCRAPER ──────────────────────────────────
// Searches by name using Inquiry mode, returns full booking details
app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;

  if (!name && !soid) {
    return res.status(400).json({ success: false, error: 'name or soid required' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });

    // ── STEP 1: Load search page ──────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // ── STEP 2: Fill search form ──────────────────────────────
    if (soid) {
      await page.fill('input[name="soid"], input[id="soid"], input[name="SOID"]', soid);
    }
    if (name) {
      // Format: Last name (space) first name
      const formattedName = formatName(name);
      await page.fill('input[name="name"], input[id="name"], input[name="NAME"]', formattedName);
    }

    // ── STEP 3: Set dropdown to Inquiry ──────────────────────
    await page.selectOption('select', 'Inquiry');

    // ── STEP 4: Click Search ──────────────────────────────────
    await page.click('input[value="Search"], button:has-text("Search")');
    await page.waitForSelector('table', { timeout: 20000 });

    // ── STEP 5: Read results table ────────────────────────────
    const searchResults = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
      return rows.map(row => {
        const cells  = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        const link   = row.querySelector('a, input[type="button"], input[value*="Booking"]');
        const linkHref = link ? (link.href || link.onclick?.toString() || '') : '';
        return {
          name:            cells[1] || '',
          dob:             cells[2] || '',
          race:            cells[3] || '',
          sex:             cells[4] || '',
          location:        cells[5] || '',
          soid:            cells[6] || '',
          days_in_custody: cells[7] || '',
          has_booking_link: !!link,
          link_text:       link ? link.innerText || link.value || '' : ''
        };
      }).filter(r => r.name);
    });

    if (!searchResults.length) {
      await browser.close();
      return res.json({ success: true, found: false, name, results: [] });
    }

    // ── STEP 6: Click "Last Known Booking" on first result ────
    const bookingButton = await page.$('input[value*="Booking"], a:has-text("Booking"), input[value*="Last Known"]');
    if (!bookingButton) {
      await browser.close();
      return res.json({ success: true, found: true, results: searchResults, booking_detail: null });
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }),
      bookingButton.click()
    ]);

    const detailUrl = page.url();

    // ── STEP 7: Scrape full booking detail page ───────────────
    const detail = await page.evaluate(() => {
      function tableText(section) {
        const headers = Array.from(document.querySelectorAll('td.header, th'));
        for (const h of headers) {
          if (h.innerText.includes(section)) {
            const table = h.closest('table');
            if (table) return table.innerText;
          }
        }
        return '';
      }

      function getCellAfterHeader(headerText) {
        const tds = Array.from(document.querySelectorAll('td'));
        for (let i = 0; i < tds.length; i++) {
          if (tds[i].innerText.trim().toLowerCase() === headerText.toLowerCase()) {
            return (tds[i + 1] || {}).innerText?.trim() || '';
          }
        }
        return '';
      }

      function getRowAfterBold(text) {
        const bolds = Array.from(document.querySelectorAll('td b, td strong'));
        for (const b of bolds) {
          if (b.innerText.trim().toLowerCase().includes(text.toLowerCase())) {
            const tr = b.closest('tr');
            const nextTr = tr?.nextElementSibling;
            if (nextTr) return Array.from(nextTr.querySelectorAll('td')).map(t => t.innerText.trim());
          }
        }
        return [];
      }

      // All table rows as flat array for flexible parsing
      const allRows = Array.from(document.querySelectorAll('table tr')).map(tr =>
        Array.from(tr.querySelectorAll('td, th')).map(td => td.innerText.trim())
      ).filter(r => r.some(c => c));

      function findRowIdx(label) {
        for (let i = 0; i < allRows.length; i++) {
          if ((allRows[i][0] || '').toLowerCase() === label.toLowerCase()) return i;
        }
        return -1;
      }
      function findRowIdxPartial(label) {
        for (let i = 0; i < allRows.length; i++) {
          if ((allRows[i][0] || '').toLowerCase().includes(label.toLowerCase())) return i;
        }
        return -1;
      }
      function cell(r, c) { return (allRows[r]?.[c] || '').trim(); }
      function findCellAnywhere(label) {
        for (let i = 0; i < allRows.length; i++) {
          for (let j = 0; j < (allRows[i] || []).length; j++) {
            if ((allRows[i][j] || '').toLowerCase() === label.toLowerCase()) return { rowIdx: i, colIdx: j };
          }
        }
        return null;
      }
      function findCellAnywherePartial(label) {
        for (let i = 0; i < allRows.length; i++) {
          for (let j = 0; j < (allRows[i] || []).length; j++) {
            if ((allRows[i][j] || '').toLowerCase().includes(label.toLowerCase())) return { rowIdx: i, colIdx: j };
          }
        }
        return null;
      }

      // ── Booking Information ──────────────────────────────────
      const bookingHeaderRow = findRowIdx('Agency ID');
      const bookingDataRow   = bookingHeaderRow >= 0 ? bookingHeaderRow + 1 : -1;
      const agencyId         = bookingDataRow >= 0 ? cell(bookingDataRow, 0) : '';
      const arrestDateTime   = bookingDataRow >= 0 ? cell(bookingDataRow, 1) : '';
      const bookingStarted   = bookingDataRow >= 0 ? cell(bookingDataRow, 2) : '';
      const bookingComplete  = bookingDataRow >= 0 ? cell(bookingDataRow, 3) : '';

      // ── Personal Information ─────────────────────────────────
      const personalHeaderRow = findRowIdx('Name');
      const personalDataRow   = personalHeaderRow >= 0 ? personalHeaderRow + 1 : -1;
      const fullName          = personalDataRow >= 0 ? cell(personalDataRow, 0) : '';
      const dob               = personalDataRow >= 0 ? cell(personalDataRow, 1) : '';
      const raceSex           = personalDataRow >= 0 ? cell(personalDataRow, 2) : '';
      const location          = personalDataRow >= 0 ? cell(personalDataRow, 3) : '';
      const soidVal           = personalDataRow >= 0 ? cell(personalDataRow, 4) : '';
      const daysInCustody     = personalDataRow >= 0 ? cell(personalDataRow, 5) : '';

      // ── Physical ─────────────────────────────────────────────
      const physHeaderRow = findRowIdx('Height');
      const physDataRow   = physHeaderRow >= 0 ? physHeaderRow + 1 : -1;
      let   height        = physDataRow >= 0 ? cell(physDataRow, 0) : '';
      if (/^\d{3,4}$/.test(height)) {
        const h = height.padStart(3, '0');
        height = `${h[0]}'${h.slice(1)}"`;
      }
      const weight = physDataRow >= 0 ? cell(physDataRow, 1) : '';
      const hair   = physDataRow >= 0 ? cell(physDataRow, 2) : '';
      const eyes   = physDataRow >= 0 ? cell(physDataRow, 3) : '';

      // ── Address ──────────────────────────────────────────────
      const addrHeaderRow = findRowIdx('Address');
      const addrDataRow   = addrHeaderRow >= 0 ? addrHeaderRow + 1 : -1;
      const addrStreet    = addrDataRow >= 0 ? cell(addrDataRow, 0) : '';
      const addrCity      = addrDataRow >= 0 ? cell(addrDataRow, 1) : '';
      const addrState     = addrDataRow >= 0 ? cell(addrDataRow, 2) : '';
      const addrZip       = addrDataRow >= 0 ? cell(addrDataRow, 3) : '';
      const address       = [addrStreet, addrCity, addrState, addrZip].filter(Boolean).join(', ');

      // ── Place of Birth ────────────────────────────────────────
      const pobHeaderRow = findRowIdx('Place of Birth');
      const placeOfBirth = pobHeaderRow >= 0 ? cell(pobHeaderRow, 1) : '';

      // ── Arrest Circumstances ─────────────────────────────────
      const arrestHeaderRow = findRowIdx('Arrest Agency');
      const arrestDataRow   = arrestHeaderRow >= 0 ? arrestHeaderRow + 1 : -1;
      const arrestAgency    = arrestDataRow >= 0 ? cell(arrestDataRow, 0) : '';
      const arrestOfficer   = arrestDataRow >= 0 ? cell(arrestDataRow, 1) : '';
      const locationOfArrest= arrestDataRow >= 0 ? cell(arrestDataRow, 2) : '';
      const serialNum       = arrestDataRow >= 0 ? cell(arrestDataRow, 3) : '';

      // ── Charges (can be multiple) ─────────────────────────────
      const chargeHeaderRow = findRowIdx('Offense Date');
      const bondAmountRow   = findRowIdx('Bond Amount');
      const charges = [];
      if (chargeHeaderRow >= 0) {
        const endRow = bondAmountRow >= 0 ? bondAmountRow : chargeHeaderRow + 30;
        for (let r = chargeHeaderRow + 1; r < endRow; r++) {
          const row = allRows[r] || [];
          const desc = (row[2] || '').trim();
          if (desc && desc.toLowerCase() !== 'n/a' && desc.length > 2 &&
              !['offense date','description','type','warrant','case'].includes(desc.toLowerCase())) {
            charges.push({
              offense_date:  (row[0] || '').trim(),
              code_section:  (row[1] || '').trim(),
              description:   desc,
              type:          (row[3] || '').trim(),
              counts:        (row[4] || '').trim(),
              bond:          (row[5] || '').trim(),
            });
          }
        }
      }

      // ── Warrant / Case ────────────────────────────────────────
      const warrantCell     = findCellAnywhere('Warrant');
      const warrant         = warrantCell ? cell(warrantCell.rowIdx, warrantCell.colIdx + 1) : '';
      const caseCell        = findCellAnywhere('Case');
      const caseNum         = caseCell ? cell(caseCell.rowIdx, caseCell.colIdx + 1) : '';
      const otnCell         = findCellAnywhere('OTN');
      const otn             = otnCell ? cell(otnCell.rowIdx, otnCell.colIdx + 1) : '';

      // ── Bond ──────────────────────────────────────────────────
      const totalBond       = bondAmountRow >= 0 ? cell(bondAmountRow, 1) : '';
      const bondStatusCell  = findCellAnywherePartial('Bond Status');
      const bondStatus      = bondStatusCell ? cell(bondStatusCell.rowIdx, bondStatusCell.colIdx + 1) : '';
      const bondingCompany  = bondStatusCell ? cell(bondStatusCell.rowIdx, bondStatusCell.colIdx + 2) : '';

      // ── Bondsman / Case-Warrant ───────────────────────────────
      const caseWarrantCell = findCellAnywherePartial('Case/Warrant');
      let caseWarrant = '', bondsmanName = '';
      if (caseWarrantCell) {
        caseWarrant  = cell(caseWarrantCell.rowIdx + 1, caseWarrantCell.colIdx);
        bondsmanName = cell(caseWarrantCell.rowIdx + 1, caseWarrantCell.colIdx + 1);
      }

      // ── Attorney ──────────────────────────────────────────────
      const attorneyHeaderRow = findRowIdxPartial('Attorney');
      const attorneyText = document.body.innerText.includes('No Attorney of Record')
        ? '' : (attorneyHeaderRow >= 0 ? cell(attorneyHeaderRow + 1, 0) : '');

      // ── Release Information ───────────────────────────────────
      const releaseHeaderRow = findRowIdx('Release Date');
      const releaseDataRow   = releaseHeaderRow >= 0 ? releaseHeaderRow + 1 : -1;
      const releaseDate      = releaseDataRow >= 0 ? cell(releaseDataRow, 0) : '';
      const releaseOfficer   = releaseDataRow >= 0 ? cell(releaseDataRow, 1) : '';
      const releasedTo       = releaseDataRow >= 0 ? cell(releaseDataRow, 2) : '';
      const notReleased      = document.body.innerText.includes('Not Released');
      const isReleased       = !notReleased && !location.toLowerCase().includes('jail');

      // ── Disposition ───────────────────────────────────────────
      const dispositionCell = findCellAnywhere('Disposition');
      const disposition     = dispositionCell ? cell(dispositionCell.rowIdx, dispositionCell.colIdx + 1) : '';

      return {
        // Booking
        agency_id:          agencyId,
        arrest_date_time:   arrestDateTime,
        booking_started:    bookingStarted,
        booking_complete:   bookingComplete,
        // Personal
        full_name:          fullName,
        dob,
        race_sex:           raceSex,
        location,
        soid:               soidVal,
        days_in_custody:    daysInCustody,
        // Physical
        height, weight, hair, eyes,
        // Address
        address,
        address_street:     addrStreet,
        address_city:       addrCity,
        address_state:      addrState,
        address_zip:        addrZip,
        place_of_birth:     placeOfBirth,
        // Arrest
        arresting_agency:   arrestAgency,
        arrest_officer:     arrestOfficer,
        location_of_arrest: locationOfArrest,
        serial_number:      serialNum,
        // Charges
        charges,
        charges_description: charges.map(c => c.description).join('; '),
        charge_type: [...new Set(charges.map(c => {
          if (c.type.toLowerCase().includes('felony'))      return 'Felony';
          if (c.type.toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
          return c.type;
        }).filter(Boolean))].join('; '),
        // Warrant / Case
        warrant, case_number: caseNum, otn,
        case_warrant:       caseWarrant,
        // Bond
        bonding_amount:     totalBond,
        bond_status:        bondStatus,
        bonding_company:    bondingCompany,
        bondsman_name:      bondsmanName,
        // Release
        is_released:        isReleased,
        release_date:       releaseDate,
        release_officer:    releaseOfficer,
        released_to:        releasedTo,
        // Legal
        attorney:           attorneyText,
        disposition,
        // Meta
        allRows,
      };
    });

    // ── Parse race / sex ──────────────────────────────────────
    const raceSexParts = (detail.race_sex || '').split('/');
    const raceMap = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
    const race    = raceMap[raceSexParts[0]?.trim()] || raceSexParts[0]?.trim() || '';
    const sexRaw  = raceSexParts[1]?.trim() || '';
    const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;

    // ── Normalize SOID ────────────────────────────────────────
    const soidRaw  = detail.soid || searchResults[0]?.soid || '';
    const soidNorm = soidRaw ? String(parseInt(soidRaw, 10)) : '';

    await browser.close();

    return res.json({
      success:       true,
      found:         true,
      search_name:   name || '',
      detail_url:    detailUrl,
      scraped_at:    new Date().toISOString(),
      // All data structured for direct Supabase insert
      data: {
        event_id:            soidNorm,
        full_name:           detail.full_name || searchResults[0]?.name || '',
        original_name:       name || '',
        charges:             detail.charges_description,
        charge_type:         detail.charge_type,
        county:              'Cobb',
        custody_status:      detail.location,
        is_released:         detail.is_released,
        bonding_amount:      detail.bonding_amount,
        bonding_company:     detail.bonding_company,
        booking_date:        detail.booking_started,
        end_of_booking_date: detail.booking_complete,
        booking_number:      detail.serial_number,
        address:             detail.address,
        arresting_agency:    detail.arresting_agency,
        arrest_officer:      detail.arrest_officer,
        days_in_custody:     detail.days_in_custody,
        place_of_birth:      detail.place_of_birth,
        date_of_birth:       detail.dob,
        attorney:            detail.attorney,
        bondsman_name:       detail.bondsman_name,
        case_warrant:        detail.case_warrant,
        bond_status:         detail.bond_status,
        race, sex,
        height:              detail.height,
        weight:              detail.weight,
        hair:                detail.hair,
        eyes:                detail.eyes,
        processed:           false,
        locked:              false,
        scraped_at:          new Date().toISOString(),
        // Extra fields
        warrant:             detail.warrant,
        case_number:         detail.case_number,
        otn:                 detail.otn,
        disposition:         detail.disposition,
        arrest_date_time:    detail.arrest_date_time,
        agency_id:           detail.agency_id,
        charges_detail:      detail.charges,
      }
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
    res.status(500).json({ success: false, error: err.message, name });
  }
});

// ─── FORMAT NAME HELPER ──────────────────────────────────────
// Gazette names come as "SMITH, JOHN" → convert to "SMITH JOHN"
// or "John Smith" → convert to "SMITH JOHN"
function formatName(raw) {
  if (!raw) return '';
  raw = raw.trim();
  // Already "LAST FIRST" format
  if (raw.includes(' ') && !raw.includes(',')) return raw.toUpperCase();
  // "LAST, FIRST" format
  if (raw.includes(',')) {
    const [last, first] = raw.split(',').map(s => s.trim());
    return `${last} ${first.split(' ')[0]}`.toUpperCase();
  }
  return raw.toUpperCase();
}

app.listen(PORT, () => {
  console.log(`🚀 Cobb County Scraper running on port ${PORT}`);
});
