const express  = require('express');
const { chromium } = require('playwright');

const app      = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';
const FORM_URL = BASE_URL + '/enter_name.shtm';

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'cobb-county-scraper', port: PORT, timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// FORMAT NAME
// "Garcia, Elvia Yadira" → "GARCIA ELVIA"
// ─────────────────────────────────────────────────────────────
function formatName(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (raw.includes(',')) {
    const parts = raw.split(',');
    return (parts[0].trim() + ' ' + parts[1].trim().split(' ')[0]).toUpperCase();
  }
  return raw.toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// LAUNCH BROWSER
// ─────────────────────────────────────────────────────────────
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
      '--ignore-certificate-errors', '--allow-running-insecure-content'
    ]
  });
}

// ─────────────────────────────────────────────────────────────
// /scrape
// ─────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;
  if (!name && !soid) return res.status(400).json({ success: false, error: 'Provide name or soid' });

  const searchName = name ? formatName(name) : '';
  console.log(`[scrape] "${name || soid}" → "${searchName}"`);

  let browser;
  try {
    browser = await launchBrowser();

    // Use a persistent browser context so cookies carry across pages
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    context.setDefaultTimeout(300000);
    context.setDefaultNavigationTimeout(300000);
    const page = await context.newPage();

    // ── STEP 1: Visit the form page to get ASP session cookie ─
    // Without ASPSESSIONID cookie the results page strips all
    // interactive elements (forms, booking buttons).
    console.log(`[scrape] Step 1 — Getting session from: ${FORM_URL}`);
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 300000 });
    console.log(`[scrape] Form loaded → ${page.url()}`);

    // Log cookies so we can confirm session was set
    const cookies = await context.cookies();
    console.log(`[scrape] Cookies after form load: ${JSON.stringify(cookies.map(c => c.name + '=' + c.value.substring(0,8)))}`);

    // ── STEP 2: Fill and submit the search form ───────────────
    // Fill NAME field
    await page.waitForSelector('input[name="name"], input[name="NAME"]', { timeout: 30000 });
    if (soid) {
      await page.fill('input[name="soid"], input[name="SOID"]', soid).catch(() => {});
    }
    await page.fill('input[name="name"], input[name="NAME"]', soid ? '' : searchName);

    // Set dropdown to Inquiry (shows released + in custody)
    await page.selectOption('select', { label: 'Inquiry' }).catch(async () => {
      await page.selectOption('select', 'Inquiry').catch(() => {});
    });

    console.log(`[scrape] Step 2 — Submitting form for: "${searchName || soid}"`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 300000 }),
      page.click('input[value="Search"]')
    ]);
    console.log(`[scrape] Results → ${page.url()}`);

    // ── STEP 3: Check for results ─────────────────────────────
    const bodyText = await page.textContent('body');
    const hasTable = await page.$('table') !== null;
    if (!hasTable || bodyText.toLowerCase().includes('no record') || bodyText.toLowerCase().includes('no match')) {
      console.log(`[scrape] No results for: ${searchName || soid}`);
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    // ── STEP 4: Parse summary row ─────────────────────────────
    const summaryRow = await page.evaluate(() => {
      for (const row of document.querySelectorAll('table tr')) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length >= 7 && cells[1] && cells[1].length > 2 &&
            !cells[1].toLowerCase().includes('name') && !cells[1].toLowerCase().includes('image')) {
          return { name: cells[1]||'', dob: cells[2]||'', race: cells[3]||'', sex: cells[4]||'', location: cells[5]||'', soid: cells[6]||'', days_in_custody: cells[7]||'' };
        }
      }
      return null;
    });

    if (!summaryRow) {
      console.log('[scrape] Could not parse results table');
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }
    console.log(`[scrape] Found: "${summaryRow.name}" SOID:${summaryRow.soid} Location:${summaryRow.location}`);

    // ── STEP 5: Extract BOOKING_ID ────────────────────────────
    // With a valid session the page should now have forms with BOOKING_ID
    const bookingInfo = await page.evaluate(() => {
      // Strategy 1: form with InmDetails action
      for (const form of document.querySelectorAll('form')) {
        const action = (form.action || '').toLowerCase();
        if (!action.includes('inmdetails') && !action.includes('inm_details')) continue;
        const inputs = {};
        form.querySelectorAll('input').forEach(i => { inputs[(i.name||'').toUpperCase()] = i.value; });
        if (inputs['BOOKING_ID']) return { soid: inputs['SOID']||'', bookingId: inputs['BOOKING_ID'] };
      }
      // Strategy 2: scan all inputs on page
      const all = {};
      document.querySelectorAll('input').forEach(i => { all[(i.name||'').toUpperCase()] = i.value; });
      if (all['BOOKING_ID']) return { soid: all['SOID']||'', bookingId: all['BOOKING_ID'] };
      // Strategy 3: any <a> with InmDetails href
      for (const a of document.querySelectorAll('a')) {
        if ((a.href||'').toLowerCase().includes('inmdetails')) return { href: a.href };
      }
      // Debug dump — log everything visible on the page
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action,
        inputs: Array.from(f.querySelectorAll('input')).map(i => i.name + '=' + i.value)
      }));
      const links = Array.from(document.querySelectorAll('a')).map(a => a.href).filter(Boolean);
      const allBtns = Array.from(document.querySelectorAll('input[type=submit]')).map(i => i.value);
      console.log('BOOKING_DEBUG forms=' + JSON.stringify(forms));
      console.log('BOOKING_DEBUG links=' + JSON.stringify(links));
      console.log('BOOKING_DEBUG buttons=' + JSON.stringify(allBtns));
      return null;
    });

    console.log(`[scrape] bookingInfo: ${JSON.stringify(bookingInfo)}`);

    if (!bookingInfo || (!bookingInfo.bookingId && !bookingInfo.href)) {
      // Last resort: click the booking button directly and follow navigation
      console.log('[scrape] bookingInfo null — attempting direct button click');
      try {
        const clicked = await Promise.race([
          // Try clicking any submit button in the results table
          (async () => {
            const btn = page.locator('table input[type="submit"]').first();
            if (await btn.count() > 0) {
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
                btn.click()
              ]);
              return page.url();
            }
            return null;
          })(),
          new Promise(resolve => setTimeout(() => resolve(null), 65000))
        ]);

        if (clicked && !clicked.includes('Error_Page') && clicked.includes('InmDetails')) {
          console.log('[scrape] Click navigation → ' + clicked);
          // Continue to parse detail page (fall through)
        } else {
          console.log('[scrape] Click did not reach InmDetails — returning summary only. URL: ' + clicked);
          await browser.close();
          return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
        }
      } catch (clickErr) {
        console.log('[scrape] Click failed: ' + clickErr.message + ' — returning summary only');
        await browser.close();
        return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
      }
    } else {
      // Navigate to detail page using extracted URL
      const detailUrl = bookingInfo.href
        ? bookingInfo.href
        : BASE_URL + '/InmDetails.asp?soid=' + encodeURIComponent((bookingInfo.soid || summaryRow.soid).trim()) + '&BOOKING_ID=' + encodeURIComponent(bookingInfo.bookingId);

      console.log(`[scrape] Navigating to detail: ${detailUrl}`);
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 300000 });
    }

    const finalUrl = page.url();
    console.log(`[scrape] Detail loaded → ${finalUrl}`);

    if (finalUrl.includes('Error_Page') || finalUrl.includes('error_page')) {
      console.log('[scrape] Error page — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name || soid) });
    }

    // ── STEP 6: Parse detail page ─────────────────────────────
    // Cell-by-cell DOM navigation — immune to nested table issues
    const detail = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      function val(label) {
        const all = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < all.length; i++) {
          if ((all[i].innerText || '').trim().toLowerCase() !== label.toLowerCase()) continue;
          // next sibling td in same row
          let sib = all[i].nextElementSibling;
          while (sib) {
            if (sib.tagName === 'TD' || sib.tagName === 'TH') {
              const v = (sib.innerText || '').trim();
              if (v) return v;
            }
            sib = sib.nextElementSibling;
          }
          // first td of next row
          const tr = all[i].closest('tr');
          if (tr && tr.nextElementSibling) {
            const td = tr.nextElementSibling.querySelector('td, th');
            if (td) return (td.innerText || '').trim();
          }
        }
        return '';
      }

      function rowAfter(label) {
        const all = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < all.length; i++) {
          if ((all[i].innerText || '').trim().toLowerCase() !== label.toLowerCase()) continue;
          const tr = all[i].closest('tr');
          if (tr && tr.nextElementSibling) {
            return Array.from(tr.nextElementSibling.querySelectorAll('td, th'))
              .map(td => (td.innerText || '').trim());
          }
        }
        return [];
      }

      // Booking Information
      const bRow            = rowAfter('agency id');
      const agencyId        = bRow[0] || '';
      const arrestDateTime  = bRow[1] || '';
      const bookingStarted  = bRow[2] || '';
      const bookingComplete = bRow[3] || '';

      // Personal Information
      const pRow        = rowAfter('name');
      const fullName    = pRow[0] || '';
      const dob         = pRow[1] || '';
      const raceSex     = pRow[2] || '';
      const location    = pRow[3] || '';
      const soidVal     = pRow[4] || '';
      const daysCustody = pRow[5] || '';

      // Physical
      const hRow   = rowAfter('height');
      let height   = hRow[0] || '';
      const weight = hRow[1] || '';
      const hair   = hRow[2] || '';
      const eyes   = hRow[3] || '';
      if (/^\d{3,4}$/.test(height)) {
        const h = height.padStart(3, '0');
        height = h[0] + "'" + h.slice(1) + '"';
      }

      // Address
      const aRow    = rowAfter('address');
      const address = [aRow[0]||'', aRow[1]||'', aRow[2]||'', aRow[3]||''].filter(Boolean).join(', ');

      // Place of Birth
      const placeOfBirth = val('place of birth');

      // Arrest Circumstances
      const arRow         = rowAfter('arrest agency');
      const arrestAgency  = arRow[0] || '';
      const arrestOfficer = arRow[1] || '';
      const locOfArrest   = arRow[2] || '';
      const serialNumber  = arRow[3] || '';

      // Warrant / Case / OTN
      const warrant = val('warrant');
      const caseNum = val('case');
      const otn     = val('otn');

      // Charges
      const charges  = [];
      let inCharges  = false;
      const skipList = ['offense date','description','type','warrant','case','disposition','counts','bond','n/a',''];
      for (const tr of document.querySelectorAll('tr')) {
        const cells   = Array.from(tr.querySelectorAll('td, th')).map(c => (c.innerText||'').trim());
        const rowText = cells.join('|').toLowerCase();
        if (!inCharges && rowText.includes('offense date') && rowText.includes('code section')) { inCharges = true; continue; }
        if (inCharges) {
          if (rowText.includes('bond amount') || rowText.includes('release information') || rowText.includes('release date') || rowText.includes('attorney')) break;
          const desc = cells[2] || '';
          if (desc && desc.length > 2 && !skipList.includes(desc.toLowerCase())) {
            charges.push({ offense_date: cells[0]||'', code_section: cells[1]||'', description: desc, type: cells[3]||'', counts: cells[4]||'', bond: cells[5]||'' });
          }
        }
      }
      const chargesDesc = charges.map(c => c.description).join('; ');
      const chargeTypes = [...new Set(charges.map(c => {
        if ((c.type||'').toLowerCase().includes('felony'))      return 'Felony';
        if ((c.type||'').toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
        return c.type;
      }).filter(Boolean))].join('; ');

      // Disposition & Bond
      const disposition = val('disposition');
      const totalBond   = val('bond amount');
      const bsRow       = rowAfter('bond status');
      const bondStatus  = bsRow[1] || val('bond status');
      const bondingCo   = bsRow[2] || '';
      const bmanRow     = rowAfter('case/warrant');
      const caseWarrant = bmanRow[0] || '';
      const bondsmanName = bmanRow[1] || '';

      // Attorney & Release
      const noAttorney     = bodyText.includes('No Attorney of Record');
      const attorney       = noAttorney ? '' : val('attorney');
      const relRow         = rowAfter('release date');
      const releaseDate    = relRow[0] || '';
      const releaseOfficer = relRow[1] || '';
      const releasedTo     = relRow[2] || '';
      const notReleased    = bodyText.includes('Not Released');
      const isReleased     = !notReleased && !(location||'').toLowerCase().includes('jail');

      return {
        agency_id: agencyId, arrest_date_time: arrestDateTime,
        booking_started: bookingStarted, booking_complete: bookingComplete,
        full_name: fullName, dob, race_sex: raceSex, location,
        soid: soidVal, days_in_custody: daysCustody,
        height, weight, hair, eyes, address, place_of_birth: placeOfBirth,
        arresting_agency: arrestAgency, arrest_officer: arrestOfficer,
        location_of_arrest: locOfArrest, serial_number: serialNumber,
        charges, charges_description: chargesDesc, charge_type: chargeTypes,
        warrant, case_number: caseNum, otn,
        case_warrant: caseWarrant, bondsman_name: bondsmanName,
        bonding_amount: totalBond, bond_status: bondStatus, bonding_company: bondingCo,
        disposition, attorney,
        release_date: releaseDate, release_officer: releaseOfficer,
        released_to: releasedTo, is_released: isReleased
      };
    });

    await browser.close();

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

    console.log(`[scrape] ✅ ${data.full_name} | id:${data.event_id} | booking:${data.booking_date} | addr:${data.address} | charges:${data.charges.substring(0,60)}`);
    return res.json({ success: true, found: true, search_name: name || soid || '', detail_url: finalUrl, scraped_at: new Date().toISOString(), data });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[scrape] ❌ "${name || soid}": ${err.message}`);
    return res.status(500).json({ success: false, found: false, error: err.message, name: name || soid || '' });
  }
});

// ─────────────────────────────────────────────────────────────
// /admissions
// ─────────────────────────────────────────────────────────────
app.post('/admissions', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    context.setDefaultTimeout(300000);
    context.setDefaultNavigationTimeout(300000);
    const page = await context.newPage();

    const admUrl = BASE_URL + '/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions';
    console.log(`[admissions] GET ${admUrl}`);
    await page.goto(admUrl, { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForSelector('table', { timeout: 300000 });

    const inmates = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (!cells[1] || cells[1].length < 2) return null;
        return { name: cells[1]||'', dob: cells[2]||'', race: cells[3]||'', sex: cells[4]||'', location: cells[5]||'', soid: cells[6]||'', days_in_custody: cells[7]||'' };
      }).filter(Boolean)
    );

    await browser.close();
    console.log(`[admissions] ✅ ${inmates.length} inmates`);
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
  const race    = raceMap[(summaryRow.race||'').trim()] || summaryRow.race || '';
  const sexRaw  = (summaryRow.sex||'').trim();
  const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;
  return {
    event_id: eventId, full_name: summaryRow.name||'', original_name: originalName||'',
    charges: '', charge_type: '', county: 'Cobb',
    custody_status: summaryRow.location||'',
    is_released: (summaryRow.location||'').toUpperCase() === 'RELEASED',
    bonding_amount: '', bonding_company: '', booking_date: '',
    date_of_birth: summaryRow.dob||'', days_in_custody: summaryRow.days_in_custody||'',
    race, sex, processed: false, locked: false, scraped_at: new Date().toISOString()
  };
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cobb County Scraper running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
