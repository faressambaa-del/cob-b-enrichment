const express  = require('express');
const { chromium } = require('playwright');

const app      = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';
const FORM_URL = BASE_URL + '/enter_name.shtm';

// ─────────────────────────────────────────────────────────────
// PROXY CONFIG — Webshare residential proxy
// ─────────────────────────────────────────────────────────────
const PROXY = {
  server:   'http://31.59.20.176:6754',
  username: 'tznskjmn',
  password: 'ag3c9yyj3w0l'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT, proxy: PROXY.server, timestamp: new Date().toISOString() });
});

function formatName(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (raw.includes(',')) {
    const parts = raw.split(',');
    return (parts[0].trim() + ' ' + parts[1].trim().split(' ')[0]).toUpperCase();
  }
  return raw.toUpperCase();
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    proxy: PROXY,
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
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language':           'en-US,en;q=0.9',
        'Accept-Encoding':           'gzip, deflate',
        'Connection':                'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    context.setDefaultTimeout(300000);
    context.setDefaultNavigationTimeout(300000);
    const page = await context.newPage();

    // ── STEP 1: Load form page — establishes ASP session cookie ─
    console.log(`[scrape] Step 1 — ${FORM_URL}`);
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 300000 });
    console.log(`[scrape] Form loaded → ${page.url()}`);

    const cookies = await context.cookies();
    console.log(`[scrape] Session cookies: ${JSON.stringify(cookies.map(c => c.name + '=' + c.value.substring(0,12)))}`);

    // Dump inputs so we can confirm form structure
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select')).map(el => ({ tag: el.tagName, type: el.type||'', name: el.name||'', id: el.id||'' }))
    );
    console.log(`[scrape] Form inputs: ${JSON.stringify(inputs)}`);

    // ── STEP 2: Fill form ─────────────────────────────────────
    const nameSelectors = ['input[name="name"]','input[name="NAME"]','input[name="inmate_name"]','input[type="text"]'];
    let nameFilled = false;
    for (const sel of nameSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(soid ? '' : searchName);
        console.log(`[scrape] Filled "${sel}"`);
        nameFilled = true;
        break;
      }
    }
    if (!nameFilled) {
      const html = await page.content();
      console.log(`[scrape] ❌ Name input not found. HTML: ${html.substring(0, 1000)}`);
      await browser.close();
      return res.status(500).json({ success: false, error: 'Form did not render — check proxy', name: name || soid });
    }

    if (soid) {
      const soidEl = await page.$('input[name="soid"], input[name="SOID"]');
      if (soidEl) await soidEl.fill(soid);
    }

    const selectEl = await page.$('select');
    if (selectEl) {
      await selectEl.selectOption({ label: 'Inquiry' }).catch(async () => {
        await selectEl.selectOption('Inquiry').catch(() => {});
      });
    }

    // ── STEP 3: Submit ────────────────────────────────────────
    const searchBtn = await page.$('input[value="Search"], input[type="submit"]');
    if (!searchBtn) {
      console.log('[scrape] ❌ Search button not found');
      await browser.close();
      return res.status(500).json({ success: false, error: 'Search button not found', name: name || soid });
    }

    console.log(`[scrape] Step 3 — Submitting search`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 300000 }),
      searchBtn.click()
    ]);
    console.log(`[scrape] Results → ${page.url()}`);

    const cookies2 = await context.cookies();
    console.log(`[scrape] Cookies after submit: ${JSON.stringify(cookies2.map(c => c.name + '=' + c.value.substring(0,12)))}`);

    // ── STEP 4: Check results ─────────────────────────────────
    const bodyText = await page.textContent('body');
    const hasTable = await page.$('table') !== null;
    if (!hasTable || bodyText.toLowerCase().includes('no record') || bodyText.toLowerCase().includes('no match')) {
      console.log(`[scrape] No results for: ${searchName || soid}`);
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    // ── STEP 5: Parse summary row ─────────────────────────────
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

    // ── STEP 6: Extract BOOKING_ID ────────────────────────────
    const pageState = await page.evaluate(() => {
      const forms   = Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action, method: f.method,
        inputs: Array.from(f.querySelectorAll('input')).map(i => ({ name: i.name, value: i.value, type: i.type }))
      }));
      const links   = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
      const buttons = Array.from(document.querySelectorAll('input[type=submit]')).map(i => ({ val: i.value, form: i.form ? i.form.action : '' }));
      return { forms, links, buttons };
    });
    console.log(`[scrape] Page state: forms=${pageState.forms.length} links=${pageState.links.length} buttons=${JSON.stringify(pageState.buttons)}`);

    let bookingId = '', bookingSoid = summaryRow.soid;

    // Strategy 1: form with InmDetails action
    for (const form of pageState.forms) {
      if (!(form.action||'').toLowerCase().includes('inmdetails')) continue;
      for (const inp of form.inputs) {
        if ((inp.name||'').toUpperCase() === 'BOOKING_ID' && inp.value) bookingId   = inp.value;
        if ((inp.name||'').toUpperCase() === 'SOID'       && inp.value) bookingSoid = inp.value;
      }
      if (bookingId) break;
    }
    // Strategy 2: any input named BOOKING_ID anywhere
    if (!bookingId) {
      for (const form of pageState.forms) {
        for (const inp of form.inputs) {
          if ((inp.name||'').toUpperCase() === 'BOOKING_ID' && inp.value) {
            bookingId = inp.value;
            const s = form.inputs.find(i => (i.name||'').toUpperCase() === 'SOID');
            if (s && s.value) bookingSoid = s.value;
            break;
          }
        }
        if (bookingId) break;
      }
    }
    // Strategy 3: href link to InmDetails
    if (!bookingId) {
      const inmLink = pageState.links.find(l => l.toLowerCase().includes('inmdetails'));
      if (inmLink) {
        console.log(`[scrape] Using href link: ${inmLink}`);
        await page.goto(inmLink, { waitUntil: 'domcontentloaded', timeout: 300000 });
        const u = page.url();
        if (!u.includes('Error_Page')) {
          const detail = await parseDetailPage(page);
          await browser.close();
          return res.json({ success: true, found: true, detail_url: u, scraped_at: new Date().toISOString(), data: buildRecord(detail, summaryRow, name||soid) });
        }
      }
    }
    // Strategy 4: click first submit button in results table
    if (!bookingId) {
      console.log('[scrape] No BOOKING_ID found — trying direct click');
      try {
        const btn = page.locator('table input[type="submit"]').first();
        if (await btn.count() > 0) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            btn.click()
          ]);
          const u = page.url();
          console.log(`[scrape] Click → ${u}`);
          if (u.includes('InmDetails') && !u.includes('Error_Page')) {
            const detail = await parseDetailPage(page);
            await browser.close();
            return res.json({ success: true, found: true, detail_url: u, scraped_at: new Date().toISOString(), data: buildRecord(detail, summaryRow, name||soid) });
          }
        }
      } catch (e) { console.log('[scrape] Click failed: ' + e.message); }
      console.log('[scrape] All strategies exhausted — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name||soid) });
    }

    // ── STEP 7: Navigate to detail ────────────────────────────
    const detailUrl = BASE_URL + '/InmDetails.asp?soid=' + encodeURIComponent(bookingSoid.trim()) + '&BOOKING_ID=' + encodeURIComponent(bookingId);
    console.log(`[scrape] Detail URL: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 300000 });
    const finalUrl = page.url();
    console.log(`[scrape] Detail loaded → ${finalUrl}`);

    if (finalUrl.includes('Error_Page')) {
      console.log('[scrape] Error page — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name||soid) });
    }

    const detail = await parseDetailPage(page);
    await browser.close();
    return res.json({ success: true, found: true, detail_url: finalUrl, scraped_at: new Date().toISOString(), data: buildRecord(detail, summaryRow, name||soid) });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[scrape] ❌ "${name||soid}": ${err.message}`);
    return res.status(500).json({ success: false, found: false, error: err.message, name: name||soid||'' });
  }
});

// ─────────────────────────────────────────────────────────────
// PARSE DETAIL PAGE — cell-by-cell, immune to nested tables
// ─────────────────────────────────────────────────────────────
async function parseDetailPage(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || '';

    function val(label) {
      const all = Array.from(document.querySelectorAll('td, th'));
      for (let i = 0; i < all.length; i++) {
        if ((all[i].innerText||'').trim().toLowerCase() !== label.toLowerCase()) continue;
        let sib = all[i].nextElementSibling;
        while (sib) {
          if (sib.tagName === 'TD' || sib.tagName === 'TH') { const v = (sib.innerText||'').trim(); if (v) return v; }
          sib = sib.nextElementSibling;
        }
        const tr = all[i].closest('tr');
        if (tr && tr.nextElementSibling) {
          const td = tr.nextElementSibling.querySelector('td, th');
          if (td) return (td.innerText||'').trim();
        }
      }
      return '';
    }

    function rowAfter(label) {
      const all = Array.from(document.querySelectorAll('td, th'));
      for (let i = 0; i < all.length; i++) {
        if ((all[i].innerText||'').trim().toLowerCase() !== label.toLowerCase()) continue;
        const tr = all[i].closest('tr');
        if (tr && tr.nextElementSibling)
          return Array.from(tr.nextElementSibling.querySelectorAll('td, th')).map(td => (td.innerText||'').trim());
      }
      return [];
    }

    const bRow            = rowAfter('agency id');
    const pRow            = rowAfter('name');
    const hRow            = rowAfter('height');
    const aRow            = rowAfter('address');
    const arRow           = rowAfter('arrest agency');
    const bsRow           = rowAfter('bond status');
    const bmanRow         = rowAfter('case/warrant');
    const relRow          = rowAfter('release date');

    let height = hRow[0] || '';
    if (/^\d{3,4}$/.test(height)) { const h = height.padStart(3,'0'); height = h[0]+"'"+h.slice(1)+'"'; }

    const location = pRow[3] || '';
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
        if (desc && desc.length > 2 && !skipList.includes(desc.toLowerCase()))
          charges.push({ offense_date: cells[0]||'', code_section: cells[1]||'', description: desc, type: cells[3]||'', counts: cells[4]||'', bond: cells[5]||'' });
      }
    }

    return {
      agency_id:          bRow[0]||'',  arrest_date_time:  bRow[1]||'',
      booking_started:    bRow[2]||'',  booking_complete:  bRow[3]||'',
      full_name:          pRow[0]||'',  dob:               pRow[1]||'',
      race_sex:           pRow[2]||'',  location,
      soid:               pRow[4]||'',  days_in_custody:   pRow[5]||'',
      height, weight: hRow[1]||'', hair: hRow[2]||'', eyes: hRow[3]||'',
      address: [aRow[0]||'',aRow[1]||'',aRow[2]||'',aRow[3]||''].filter(Boolean).join(', '),
      place_of_birth:     val('place of birth'),
      arresting_agency:   arRow[0]||'', arrest_officer:    arRow[1]||'',
      location_of_arrest: arRow[2]||'', serial_number:     arRow[3]||'',
      warrant:  val('warrant'),  case_number: val('case'), otn: val('otn'),
      charges,
      charges_description: charges.map(c => c.description).join('; '),
      charge_type: [...new Set(charges.map(c => {
        if ((c.type||'').toLowerCase().includes('felony'))      return 'Felony';
        if ((c.type||'').toLowerCase().includes('misdemeanor')) return 'Misdemeanor';
        return c.type;
      }).filter(Boolean))].join('; '),
      disposition:        val('disposition'),
      bonding_amount:     val('bond amount'),
      bond_status:        bsRow[1] || val('bond status'),
      bonding_company:    bsRow[2]||'',
      case_warrant:       bmanRow[0]||'',  bondsman_name: bmanRow[1]||'',
      attorney:           bodyText.includes('No Attorney of Record') ? '' : val('attorney'),
      release_date:       relRow[0]||'',   release_officer: relRow[1]||'', released_to: relRow[2]||'',
      is_released:        !bodyText.includes('Not Released') && !location.toLowerCase().includes('jail')
    };
  });
}

// ─────────────────────────────────────────────────────────────
// BUILD FINAL RECORD
// ─────────────────────────────────────────────────────────────
function buildRecord(detail, summaryRow, originalName) {
  const rsp     = (detail.race_sex||'').replace(/\s/g,'').split('/');
  const raceMap = { B:'Black', W:'White', H:'Hispanic', A:'Asian', O:'Other', I:'Indigenous', U:'Unknown' };
  const race    = raceMap[rsp[0]] || rsp[0] || summaryRow.race || '';
  const sexRaw  = rsp[1] || summaryRow.sex || '';
  const sex     = sexRaw === 'M' ? 'Male' : sexRaw === 'F' ? 'Female' : sexRaw;
  const rawSoid = (detail.soid || summaryRow.soid || '').trim();
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g,''), 10)) : '';

  return {
    event_id:            eventId,
    full_name:           detail.full_name || summaryRow.name || '',
    original_name:       originalName || '',
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
}

// ─────────────────────────────────────────────────────────────
// BASIC DATA — summary row only fallback
// ─────────────────────────────────────────────────────────────
function buildBasicData(summaryRow, originalName) {
  const rawSoid = (summaryRow.soid||'').trim();
  const eventId = rawSoid ? String(parseInt(rawSoid.replace(/\D/g,''), 10)) : '';
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cobb County Scraper running on port ${PORT}`);
  console.log(`Proxy: ${PROXY.server}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
