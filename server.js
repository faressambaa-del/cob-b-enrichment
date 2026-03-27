const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BASE_URL   = 'http://inmate-search.cobbsheriff.org';
const FORM_URL   = BASE_URL + '/enter_name.shtm';

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'cobb-county-scraper',
    port: PORT,
    form_url: FORM_URL,
    timestamp: new Date().toISOString()
  });
});

function formatName(raw) {
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

app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;
  if (!name && !soid) {
    return res.status(400).json({ success: false, error: 'Provide name or soid' });
  }

  const searchName = name ? formatName(name) : '';
  console.log(`[scrape] ▶ "${name || soid}" → "${searchName}"`);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    });

    // ✅ ALL timeouts set to 300000ms (5 minutes)
    page.setDefaultTimeout(300000);
    page.setDefaultNavigationTimeout(300000);

    // ── STEP 1: Load enter_name.shtm ─────────────────────────
    console.log(`[scrape] Loading form: ${FORM_URL}`);
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 300000 });
    console.log(`[scrape] Form loaded → ${page.url()}`);

    await page.waitForSelector('input[name="name"], input[name="NAME"]', { timeout: 300000 });

    // ── STEP 2: Fill SOID and/or NAME field ──────────────────
    if (soid) {
      await page.locator('input[name="soid"], input[name="SOID"]')
        .first().fill(soid).catch(() => {});
      console.log(`[scrape] Filled SOID: "${soid}"`);
    }
    if (searchName) {
      await page.locator('input[name="name"], input[name="NAME"]')
        .first().fill(searchName);
      console.log(`[scrape] Filled NAME: "${searchName}"`);
    }

    // ── STEP 3: Set dropdown to Inquiry ──────────────────────
    await page.locator('select').first()
      .selectOption({ label: 'Inquiry' })
      .catch(async () => {
        await page.locator('select').first().selectOption('Inquiry').catch(() => {});
      });
    console.log(`[scrape] Dropdown → Inquiry`);

    // ── STEP 4: Click Search ──────────────────────────────────
    console.log(`[scrape] Clicking Search...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 300000 }),
      page.locator('input[value="Search"]').first().click()
    ]);
    console.log(`[scrape] Results → ${page.url()}`);

    // ── STEP 5: Check for results ─────────────────────────────
    const bodyText = await page.textContent('body');
    const hasTable = (await page.$('table')) !== null;

    if (!hasTable ||
        bodyText.toLowerCase().includes('no record') ||
        bodyText.toLowerCase().includes('no match') ||
        bodyText.toLowerCase().includes('0 record')) {
      console.log(`[scrape] No results found for: ${searchName || soid}`);
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    const summaryRow = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length >= 7 && cells[1] && cells[1].length > 2 &&
            !cells[1].toLowerCase().includes('name') &&
            !cells[1].toLowerCase().includes('image')) {
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

    console.log(`[scrape] Found: "${summaryRow.name}" | SOID:${summaryRow.soid} | Location:${summaryRow.location}`);

    // ── STEP 6: Click "Last Known Booking" button ─────────────
    const bookingBtn = await page.$(
      'input[value="Last Known Booking"], input[value*="Last Known"], input[value*="Booking"]'
    );

    if (!bookingBtn) {
      console.log(`[scrape] No booking button — returning summary only`);
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
    }

    console.log(`[scrape] Clicking Last Known Booking...`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 300000 }),
      bookingBtn.click()
    ]);

    const detailUrl = page.url();
    console.log(`[scrape] Detail page → ${detailUrl}`);

    // Bail if error page
    if (detailUrl.includes('Error_Page') || detailUrl.includes('error_page')) {
      console.log(`[scrape] Error page — returning summary only`);
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
    }

    // ── STEP 7: Scrape ALL sections from detail page ──────────
    const detail = await page.evaluate(() => {
      const body = document.body.innerText || '';

      // Navigate DOM relationally — find a <td> by label text,
      // then get the value from the next sibling td or next row.
      // This is immune to nested-table index confusion.
      function getValueAfterLabel(label) {
        const tds = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < tds.length; i++) {
          if ((tds[i].innerText || '').trim().toLowerCase() === label.toLowerCase()) {
            // Try next sibling td in same row
            let sib = tds[i].nextElementSibling;
            while (sib) {
              if (sib.tagName === 'TD' || sib.tagName === 'TH') {
                const val = (sib.innerText || '').trim();
                if (val) return val;
              }
              sib = sib.nextElementSibling;
            }
            // Try first td of next row
            const tr = tds[i].closest('tr');
            if (tr && tr.nextElementSibling) {
              const firstTd = tr.nextElementSibling.querySelector('td, th');
              if (firstTd) return (firstTd.innerText || '').trim();
            }
          }
        }
        return '';
      }

      // Returns all cells of the row AFTER the row containing the label
      function getRowAfterLabel(label) {
        const tds = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < tds.length; i++) {
          if ((tds[i].innerText || '').trim().toLowerCase() === label.toLowerCase()) {
            const tr = tds[i].closest('tr');
            if (tr && tr.nextElementSibling) {
              return Array.from(tr.nextElementSibling.querySelectorAll('td, th'))
                .map(td => (td.innerText || '').trim());
            }
          }
        }
        return [];
      }

      // ── Booking Information ──────────────────────────────────
      const bookRow         = getRowAfterLabel('Agency ID');
      const agencyId        = bookRow[0] || '';
      const arrestDateTime  = bookRow[1] || '';
      const bookingStarted  = bookRow[2] || '';
      const bookingComplete = bookRow[3] || '';

      // ── Personal Information ─────────────────────────────────
      const persRow     = getRowAfterLabel('Name');
      const fullName      = persRow[0] || '';
      const dob           = persRow[1] || '';
      const raceSex       = persRow[2] || '';
      const location      = persRow[3] || '';
      const soidVal       = persRow[4] || '';
      const daysInCustody = persRow[5] || '';

      // ── Physical ─────────────────────────────────────────────
      const physRow = getRowAfterLabel('Height');
      let height    = physRow[0] || '';
      const weight  = physRow[1] || '';
      const hair    = physRow[2] || '';
      const eyes    = physRow[3] || '';
      if (/^\d{3,4}$/.test(height)) {
        const h = height.padStart(3, '0');
        height = h[0] + "'" + h.slice(1) + '"';
      }

      // ── Address ──────────────────────────────────────────────
      const addrRow    = getRowAfterLabel('Address');
      const addrStreet = addrRow[0] || '';
      const addrCity   = addrRow[1] || '';
      const addrState  = addrRow[2] || '';
      const addrZip    = addrRow[3] || '';
      const address    = [addrStreet, addrCity, addrState, addrZip].filter(Boolean).join(', ');

      // ── Place of Birth ────────────────────────────────────────
      const placeOfBirth = getValueAfterLabel('Place of Birth');

      // ── Arrest Circumstances ─────────────────────────────────
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
      const charges = [];
      const allTrs  = Array.from(document.querySelectorAll('tr'));
      let inCharges = false;
      for (const tr of allTrs) {
        const cells   = Array.from(tr.querySelectorAll('td, th')).map(c => (c.innerText || '').trim());
        const rowText = cells.join('|').toLowerCase();
        if (!inCharges && rowText.includes('offense date') && rowText.includes('code section')) {
          inCharges = true;
          continue;
        }
        if (inCharges) {
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
      const chargesDesc = charges.map(ch => ch.description).join('; ');
      const chargeTypes = [...new Set(charges.map(ch => {
        if ((ch.type || '').toLowerCase().includes('felony'))      return 'Felony';
        if ((ch.type || '').toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
        return ch.type;
      }).filter(Boolean))].join('; ');

      // ── Disposition ───────────────────────────────────────────
      const disposition = getValueAfterLabel('Disposition');

      // ── Bond ─────────────────────────────────────────────────
      const totalBond  = getValueAfterLabel('Bond Amount');
      const bondRow    = getRowAfterLabel('Bond Status');
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

    // Parse race/sex "W /F" → race=White sex=Female
    const rsp     = (detail.race_sex || '').replace(/\s/g, '').split('/');
    const raceMap = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
    const race    = raceMap[rsp[0]] || rsp[0] || summaryRow.race || '';
    const sexRaw  = rsp[1] || summaryRow.sex || '';
    const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;

    const rawSoid = (detail.soid || summaryRow.soid || '').trim();
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

    console.log(`[scrape] ✅ ${data.full_name} | id:${data.event_id} | released:${data.is_released} | charges:${data.charges.substring(0,60)}`);

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
// /admissions
// ─────────────────────────────────────────────────────────────
app.post('/admissions', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    page.setDefaultTimeout(300000);
    page.setDefaultNavigationTimeout(300000);

    const admUrl = `${BASE_URL}/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions`;
    console.log(`[admissions] Loading: ${admUrl}`);
    await page.goto(admUrl, { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForSelector('table', { timeout: 300000 });

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
    console.log(`[admissions] ✅ Found ${inmates.length} inmates`);
    res.json({ success: true, count: inmates.length, inmates });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[admissions] ❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────
function buildBasicData(summaryRow, originalName) {
  const rawSoid = (summaryRow.soid || '').trim();
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
    race, sex,
    processed:       false,
    locked:          false,
    scraped_at:      new Date().toISOString()
  };
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Cobb County Scraper running on port ${PORT}`);
  console.log(`   Entry form: ${FORM_URL}`);
});
