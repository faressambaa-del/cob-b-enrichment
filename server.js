const express    = require('express');
const { chromium } = require('playwright');
const http       = require('http');
const https      = require('https');

const app  = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';
const FORM_URL = BASE_URL + '/enter_name.shtm';

// ─────────────────────────────────────────────────────────────
// PROXY — used by node http requests to seed the ASP session
// Playwright will use the same proxy config
// ─────────────────────────────────────────────────────────────
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = 6754;
const PROXY_USER = 'tznskjmn';
const PROXY_PASS = 'ag3c9yyj3w0l';
const PROXY_URL  = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;

// ─────────────────────────────────────────────────────────────
// GET SESSION COOKIE via raw Node HTTP through the proxy
// This bypasses Playwright's CONNECT tunnel issue entirely.
// We make a raw GET to the form page via the proxy using Node's
// http module, extract Set-Cookie headers, then pass cookies
// into the Playwright context.
// ─────────────────────────────────────────────────────────────
function getSessionCookie() {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const options = {
      host:    PROXY_HOST,
      port:    PROXY_PORT,
      method:  'GET',
      path:    FORM_URL,
      headers: {
        'Host':              'inmate-search.cobbsheriff.org',
        'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':   'en-US,en;q=0.9',
        'Proxy-Authorization': `Basic ${auth}`,
        'Connection':        'keep-alive'
      }
    };

    const req = http.request(options, (resp) => {
      const cookies = resp.headers['set-cookie'] || [];
      let body = '';
      resp.on('data', chunk => { body += chunk; });
      resp.on('end', () => {
        console.log(`[session] HTTP ${resp.statusCode} | cookies: ${JSON.stringify(cookies)} | body length: ${body.length}`);
        resolve({ cookies, body, status: resp.statusCode });
      });
    });

    req.on('error', (err) => {
      console.log(`[session] Node HTTP error: ${err.message}`);
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Session request timed out'));
    });

    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// SUBMIT SEARCH FORM via raw Node HTTP through proxy
// Returns { cookies, body, status, location }
// ─────────────────────────────────────────────────────────────
function submitSearchForm(sessionCookies, searchName, soidVal) {
  return new Promise((resolve, reject) => {
    const auth       = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const nameParam  = soidVal ? '' : encodeURIComponent(searchName).replace(/%20/g, '+');
    const soidParam  = soidVal ? encodeURIComponent(soidVal) : '';
    const postBody   = `soid=${soidParam}&name=${nameParam}&serial=&B1=Search&qry=Inquiry`;
    const cookieStr  = sessionCookies.map(c => c.split(';')[0]).join('; ');

    const options = {
      host:    PROXY_HOST,
      port:    PROXY_PORT,
      method:  'POST',
      path:    BASE_URL + '/inquiry.asp',
      headers: {
        'Host':                  'inmate-search.cobbsheriff.org',
        'User-Agent':            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':       'en-US,en;q=0.9',
        'Content-Type':          'application/x-www-form-urlencoded',
        'Content-Length':        Buffer.byteLength(postBody),
        'Referer':               FORM_URL,
        'Cookie':                cookieStr,
        'Proxy-Authorization':   `Basic ${auth}`,
        'Connection':            'keep-alive'
      }
    };

    const req = http.request(options, (resp) => {
      const newCookies = resp.headers['set-cookie'] || [];
      const allCookies = [...sessionCookies, ...newCookies];
      let body = '';
      resp.on('data', chunk => { body += chunk; });
      resp.on('end', () => {
        console.log(`[form] POST ${resp.statusCode} | body: ${body.length} chars | location: ${resp.headers.location||'none'}`);
        resolve({ cookies: allCookies, body, status: resp.statusCode, location: resp.headers.location });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Form submit timed out')); });
    req.write(postBody);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// GET PAGE via raw Node HTTP through proxy (for results/detail)
// ─────────────────────────────────────────────────────────────
function getPage(url, cookies) {
  return new Promise((resolve, reject) => {
    const auth      = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    const options = {
      host:    PROXY_HOST,
      port:    PROXY_PORT,
      method:  'GET',
      path:    url,
      headers: {
        'Host':                  'inmate-search.cobbsheriff.org',
        'User-Agent':            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer':               BASE_URL + '/inquiry.asp',
        'Cookie':                cookieStr,
        'Proxy-Authorization':   `Basic ${auth}`,
        'Connection':            'keep-alive'
      }
    };
    const req = http.request(options, (resp) => {
      let body = '';
      resp.on('data', chunk => { body += chunk; });
      resp.on('end', () => {
        console.log(`[http] GET ${url} → ${resp.statusCode} | ${body.length} chars`);
        resolve({ body, status: resp.statusCode, cookies: resp.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('GET timed out: ' + url)); });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// PARSE HTML with Playwright (no navigation — just evaluate)
// We load the HTML into a Playwright page using setContent()
// so we get full DOM access without making any network requests
// ─────────────────────────────────────────────────────────────
async function parseHtml(browser, html) {
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return { page, context };
}

// ─────────────────────────────────────────────────────────────
// LAUNCH BROWSER — no proxy needed since we do HTTP manually
// ─────────────────────────────────────────────────────────────
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
  });
}

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
// /health
// ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const result = await getSessionCookie();
    res.json({ status: 'ok', port: PORT, proxy: PROXY_URL.replace(PROXY_PASS,'***'), site_reachable: result.status === 200, cookies: result.cookies.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ status: 'degraded', error: err.message, timestamp: new Date().toISOString() });
  }
});

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

    // ── Step 1: Get ASP session cookie via raw HTTP ───────────
    console.log('[scrape] Step 1 — getting session cookie');
    const session = await getSessionCookie();
    if (!session.cookies.length) {
      console.log('[scrape] ⚠️  No session cookie returned — proceeding anyway');
    }
    let cookies = session.cookies;
    console.log(`[scrape] Session cookies: ${JSON.stringify(cookies.map(c => c.split(';')[0]))}`);

    // Check we got a real page, not a proxy error
    if (session.body.includes('Bad gateway') || session.body.includes('bad gateway')) {
      throw new Error('Proxy bad gateway on form page');
    }

    // ── Step 2: Submit search form via raw HTTP ───────────────
    console.log('[scrape] Step 2 — submitting search form');
    const formResult = await submitSearchForm(cookies, searchName, soid);
    cookies = formResult.cookies;

    // Handle redirect if any
    let resultsHtml = formResult.body;
    if (formResult.status === 302 || formResult.status === 301) {
      const redirectUrl = formResult.location.startsWith('http')
        ? formResult.location
        : BASE_URL + formResult.location;
      console.log(`[scrape] Following redirect → ${redirectUrl}`);
      const redirectResult = await getPage(redirectUrl, cookies);
      resultsHtml = redirectResult.body;
      cookies = [...cookies, ...redirectResult.cookies];
    }

    console.log(`[scrape] Results HTML: ${resultsHtml.length} chars`);

    // ── Step 3: Parse results page ────────────────────────────
    const { page: resultsPage, context: rCtx } = await parseHtml(browser, resultsHtml);

    const bodyText = await resultsPage.textContent('body');
    const hasTable = await resultsPage.$('table') !== null;

    if (!hasTable || bodyText.toLowerCase().includes('no record') || bodyText.toLowerCase().includes('no match')) {
      await rCtx.close();
      console.log(`[scrape] No results for: ${searchName || soid}`);
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    // Parse summary row
    const summaryRow = await resultsPage.evaluate(() => {
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
      await rCtx.close();
      await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }
    console.log(`[scrape] Found: "${summaryRow.name}" SOID:${summaryRow.soid} Location:${summaryRow.location}`);

    // Extract BOOKING_ID from the results page forms
    const bookingInfo = await resultsPage.evaluate(() => {
      for (const form of document.querySelectorAll('form')) {
        const action = (form.action || form.getAttribute('action') || '').toLowerCase();
        if (!action.includes('inmdetails') && !action.includes('inm_details')) continue;
        const inputs = {};
        form.querySelectorAll('input').forEach(i => { inputs[(i.name||'').toUpperCase()] = i.value; });
        if (inputs['BOOKING_ID']) return { soid: inputs['SOID']||'', bookingId: inputs['BOOKING_ID'] };
      }
      // Scan all inputs
      const all = {};
      document.querySelectorAll('input').forEach(i => { all[(i.name||'').toUpperCase()] = i.value; });
      if (all['BOOKING_ID']) return { soid: all['SOID']||'', bookingId: all['BOOKING_ID'] };
      // href link
      for (const a of document.querySelectorAll('a')) {
        if ((a.href||'').toLowerCase().includes('inmdetails')) return { href: a.href };
      }
      // Log all forms for debug
      const debug = { forms: Array.from(document.querySelectorAll('form')).map(f => ({ action: f.action, inputs: Array.from(f.querySelectorAll('input')).map(i => i.name+'='+i.value) })), links: Array.from(document.querySelectorAll('a')).map(a => a.href).slice(0,10) };
      console.log('BOOKING_DEBUG:' + JSON.stringify(debug));
      return null;
    });

    await rCtx.close();
    console.log(`[scrape] bookingInfo: ${JSON.stringify(bookingInfo)}`);

    if (!bookingInfo || (!bookingInfo.bookingId && !bookingInfo.href)) {
      console.log('[scrape] No BOOKING_ID found — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name||soid) });
    }

    // ── Step 4: Get detail page via raw HTTP ──────────────────
    let detailUrl;
    if (bookingInfo.href) {
      detailUrl = bookingInfo.href.startsWith('http') ? bookingInfo.href : BASE_URL + '/' + bookingInfo.href.replace(/^\//, '');
    } else {
      const ds = (bookingInfo.soid || summaryRow.soid || '').trim();
      detailUrl = BASE_URL + '/InmDetails.asp?soid=' + encodeURIComponent(ds) + '&BOOKING_ID=' + encodeURIComponent(bookingInfo.bookingId);
    }

    console.log(`[scrape] Step 4 — Detail: ${detailUrl}`);
    const detailResult = await getPage(detailUrl, cookies);

    if (detailResult.body.includes('Error_Page') || detailResult.body.includes('Unauthorised')) {
      console.log('[scrape] Error page — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name||soid) });
    }

    // ── Step 5: Parse detail page ─────────────────────────────
    const { page: detailPage, context: dCtx } = await parseHtml(browser, detailResult.body);
    const detail = await parseDetailPage(detailPage);
    await dCtx.close();
    await browser.close();

    console.log(`[scrape] ✅ ${detail.full_name || summaryRow.name} | booking:${detail.booking_started} | addr:${detail.address} | charges:${detail.charges_description.substring(0,60)}`);
    return res.json({ success: true, found: true, detail_url: detailUrl, scraped_at: new Date().toISOString(), data: buildRecord(detail, summaryRow, name||soid) });

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
          if (sib.tagName==='TD'||sib.tagName==='TH') { const v=(sib.innerText||'').trim(); if(v) return v; }
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
    const bRow=rowAfter('agency id'), pRow=rowAfter('name'), hRow=rowAfter('height');
    const aRow=rowAfter('address'), arRow=rowAfter('arrest agency');
    const bsRow=rowAfter('bond status'), bmanRow=rowAfter('case/warrant'), relRow=rowAfter('release date');
    let height=hRow[0]||'';
    if(/^\d{3,4}$/.test(height)){const h=height.padStart(3,'0');height=h[0]+"'"+h.slice(1)+'"';}
    const location=pRow[3]||'';
    const charges=[];let inCharges=false;
    const skipList=['offense date','description','type','warrant','case','disposition','counts','bond','n/a',''];
    for(const tr of document.querySelectorAll('tr')){
      const cells=Array.from(tr.querySelectorAll('td,th')).map(c=>(c.innerText||'').trim());
      const rt=cells.join('|').toLowerCase();
      if(!inCharges&&rt.includes('offense date')&&rt.includes('code section')){inCharges=true;continue;}
      if(inCharges){
        if(rt.includes('bond amount')||rt.includes('release information')||rt.includes('release date')||rt.includes('attorney'))break;
        const desc=cells[2]||'';
        if(desc&&desc.length>2&&!skipList.includes(desc.toLowerCase()))
          charges.push({offense_date:cells[0]||'',code_section:cells[1]||'',description:desc,type:cells[3]||'',counts:cells[4]||'',bond:cells[5]||''});
      }
    }
    return {
      agency_id:bRow[0]||'', arrest_date_time:bRow[1]||'', booking_started:bRow[2]||'', booking_complete:bRow[3]||'',
      full_name:pRow[0]||'', dob:pRow[1]||'', race_sex:pRow[2]||'', location, soid:pRow[4]||'', days_in_custody:pRow[5]||'',
      height, weight:hRow[1]||'', hair:hRow[2]||'', eyes:hRow[3]||'',
      address:[aRow[0]||'',aRow[1]||'',aRow[2]||'',aRow[3]||''].filter(Boolean).join(', '),
      place_of_birth:val('place of birth'),
      arresting_agency:arRow[0]||'', arrest_officer:arRow[1]||'', location_of_arrest:arRow[2]||'', serial_number:arRow[3]||'',
      warrant:val('warrant'), case_number:val('case'), otn:val('otn'),
      charges, charges_description:charges.map(c=>c.description).join('; '),
      charge_type:[...new Set(charges.map(c=>{
        if((c.type||'').toLowerCase().includes('felony'))return'Felony';
        if((c.type||'').toLowerCase().includes('misdemeanor'))return'Misdemeanor';
        return c.type;
      }).filter(Boolean))].join('; '),
      disposition:val('disposition'),
      bonding_amount:val('bond amount'), bond_status:bsRow[1]||val('bond status'), bonding_company:bsRow[2]||'',
      case_warrant:bmanRow[0]||'', bondsman_name:bmanRow[1]||'',
      attorney:bodyText.includes('No Attorney of Record')?'':val('attorney'),
      release_date:relRow[0]||'', release_officer:relRow[1]||'', released_to:relRow[2]||'',
      is_released:!bodyText.includes('Not Released')&&!location.toLowerCase().includes('jail')
    };
  });
}

function buildRecord(detail, summaryRow, originalName) {
  const rsp=( detail.race_sex||'').replace(/\s/g,'').split('/');
  const raceMap={B:'Black',W:'White',H:'Hispanic',A:'Asian',O:'Other',I:'Indigenous',U:'Unknown'};
  const race=raceMap[rsp[0]]||rsp[0]||summaryRow.race||'';
  const sexRaw=rsp[1]||summaryRow.sex||'';
  const sex=sexRaw==='M'?'Male':sexRaw==='F'?'Female':sexRaw;
  const rawSoid=(detail.soid||summaryRow.soid||'').trim();
  const eventId=rawSoid?String(parseInt(rawSoid.replace(/\D/g,''),10)):'';
  return {
    event_id:eventId, full_name:detail.full_name||summaryRow.name||'', original_name:originalName||'',
    charges:detail.charges_description||'', charge_type:detail.charge_type||'', county:'Cobb',
    custody_status:detail.location||summaryRow.location||'', is_released:detail.is_released,
    bonding_amount:detail.bonding_amount||'', bonding_company:detail.bonding_company||'',
    booking_date:detail.booking_started||'', end_of_booking_date:detail.booking_complete||'',
    booking_number:detail.serial_number||'', address:detail.address||'',
    arresting_agency:detail.arresting_agency||'', arrest_officer:detail.arrest_officer||'',
    days_in_custody:detail.days_in_custody||summaryRow.days_in_custody||'',
    place_of_birth:detail.place_of_birth||'', date_of_birth:detail.dob||summaryRow.dob||'',
    attorney:detail.attorney||'', bondsman_name:detail.bondsman_name||'',
    case_warrant:detail.case_warrant||'', bond_status:detail.bond_status||'',
    race, sex, height:detail.height||'', weight:detail.weight||'', hair:detail.hair||'', eyes:detail.eyes||'',
    processed:false, locked:false, scraped_at:new Date().toISOString(),
    warrant:detail.warrant||'', case_number:detail.case_number||'', otn:detail.otn||'',
    disposition:detail.disposition||'', arrest_date_time:detail.arrest_date_time||'',
    agency_id:detail.agency_id||'', charges_detail:detail.charges||[]
  };
}

function buildBasicData(summaryRow, originalName) {
  const rawSoid=(summaryRow.soid||'').trim();
  const eventId=rawSoid?String(parseInt(rawSoid.replace(/\D/g,''),10)):'';
  const raceMap={B:'Black',W:'White',H:'Hispanic',A:'Asian',O:'Other',I:'Indigenous',U:'Unknown'};
  const race=raceMap[(summaryRow.race||'').trim()]||summaryRow.race||'';
  const sexRaw=(summaryRow.sex||'').trim();
  const sex=sexRaw==='M'?'Male':sexRaw==='F'?'Female':sexRaw;
  return {
    event_id:eventId, full_name:summaryRow.name||'', original_name:originalName||'',
    charges:'', charge_type:'', county:'Cobb', custody_status:summaryRow.location||'',
    is_released:(summaryRow.location||'').toUpperCase()==='RELEASED',
    bonding_amount:'', bonding_company:'', booking_date:'',
    date_of_birth:summaryRow.dob||'', days_in_custody:summaryRow.days_in_custody||'',
    race, sex, processed:false, locked:false, scraped_at:new Date().toISOString()
  };
}

app.post('/admissions', async (req, res) => {
  let browser;
  try {
    const session = await getSessionCookie();
    const result  = await getPage(BASE_URL + '/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions', session.cookies);
    browser = await launchBrowser();
    const { page, context } = await parseHtml(browser, result.body);
    await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
    const inmates = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        if (!cells[1]||cells[1].length<2) return null;
        return { name:cells[1]||'', dob:cells[2]||'', race:cells[3]||'', sex:cells[4]||'', location:cells[5]||'', soid:cells[6]||'', days_in_custody:cells[7]||'' };
      }).filter(Boolean)
    );
    await context.close();
    await browser.close();
    res.json({ success:true, count:inmates.length, inmates });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success:false, error:err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cobb County Scraper on port ${PORT}`);
  console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
