const express    = require('express');
const { chromium } = require('playwright');
const http       = require('http');

const app  = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const BASE_URL = 'http://inmate-search.cobbsheriff.org';
const FORM_URL = BASE_URL + '/enter_name.shtm';

// ─────────────────────────────────────────────────────────────
// PROXY — configurable via Railway environment variables.
// Go to Railway → your service → Variables and set:
//   PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS
// ─────────────────────────────────────────────────────────────
const PROXY_HOST = process.env.PROXY_HOST || '31.59.20.176';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '6754', 10);
const PROXY_USER = process.env.PROXY_USER || 'tznskjmn';
const PROXY_PASS = process.env.PROXY_PASS || 'ag3c9yyj3w0l';

// ─────────────────────────────────────────────────────────────
// CORE HTTP via forward proxy
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
    if (cookieStr) headers['Cookie'] = cookieStr;
    if (postBody) {
      headers['Content-Type']   = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(postBody);
    }

    const req = http.request(
      { host: PROXY_HOST, port: PROXY_PORT, method, path: targetUrl, headers },
      (resp) => {
        const setCookies = resp.headers['set-cookie'] || [];
        let body = '';
        resp.on('data', chunk => { body += chunk; });
        resp.on('end', () => resolve({
          status:   resp.statusCode,
          headers:  resp.headers,
          cookies:  setCookies,
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

// ─────────────────────────────────────────────────────────────
// RETRY WRAPPER
// ─────────────────────────────────────────────────────────────
async function withRetry(fn, attempts = 3, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      console.log(`[retry] attempt ${i + 1}/${attempts} failed: ${err.message}`);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────
// STEP 1: Get ASP session cookie
// ─────────────────────────────────────────────────────────────
async function getSessionCookie() {
  console.log(`[session] GET ${FORM_URL} via ${PROXY_HOST}:${PROXY_PORT}`);
  const result = await proxyRequest({ targetUrl: FORM_URL });
  console.log(`[session] HTTP ${result.status} | cookies: ${JSON.stringify(result.cookies)} | body: ${result.body.length} chars`);
  if (result.status === 407) throw new Error('Proxy auth failed (407). Update PROXY_USER/PROXY_PASS env vars.');
  if (result.body.toLowerCase().includes('bad gateway')) throw new Error('Proxy bad gateway. Check PROXY_HOST/PROXY_PORT env vars.');
  if (result.status !== 200) throw new Error(`Unexpected status ${result.status} from session GET`);
  return { cookies: result.cookies, body: result.body, status: result.status };
}

// ─────────────────────────────────────────────────────────────
// STEP 2: Submit search form
// ─────────────────────────────────────────────────────────────
async function submitSearchForm(sessionCookies, searchName, soidVal) {
  const nameParam = soidVal ? '' : encodeURIComponent(searchName).replace(/%20/g, '+');
  const soidParam = soidVal ? encodeURIComponent(soidVal) : '';
  const postBody  = `soid=${soidParam}&name=${nameParam}&serial=&B1=Search&qry=Inquiry`;
  console.log(`[form] POST /inquiry.asp | ${postBody}`);
  const result = await proxyRequest({
    method: 'POST', targetUrl: BASE_URL + '/inquiry.asp',
    postBody, cookies: sessionCookies,
    extraHeaders: { 'Referer': FORM_URL, 'Origin': BASE_URL },
  });
  console.log(`[form] ${result.status} | ${result.body.length} chars | loc: ${result.location || 'none'}`);
  return { ...result, cookies: [...sessionCookies, ...result.cookies] };
}

// ─────────────────────────────────────────────────────────────
// GET any page via proxy
// ─────────────────────────────────────────────────────────────
async function getPage(url, cookies, referer) {
  const result = await proxyRequest({ targetUrl: url, cookies, extraHeaders: referer ? { 'Referer': referer } : {} });
  console.log(`[http] GET ${url} → ${result.status} | ${result.body.length} chars`);
  return { ...result, cookies: [...cookies, ...result.cookies] };
}

// ─────────────────────────────────────────────────────────────
// Parse HTML offline with Playwright (no network calls)
// ─────────────────────────────────────────────────────────────
async function parseHtml(browser, html) {
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return { page, context };
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'],
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
    res.json({ status: 'ok', proxy: `${PROXY_HOST}:${PROXY_PORT}`, site_reachable: result.status === 200, cookies: result.cookies.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ status: 'degraded', error: err.message, proxy: `${PROXY_HOST}:${PROXY_PORT}`, hint: 'Update PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS env vars in Railway', timestamp: new Date().toISOString() });
  }
});

// ─────────────────────────────────────────────────────────────
// /proxy-test — raw diagnostic endpoint
// Hit this first when things break to check proxy health
// ─────────────────────────────────────────────────────────────
app.get('/proxy-test', async (req, res) => {
  const start = Date.now();
  try {
    const result = await proxyRequest({ targetUrl: FORM_URL });
    res.json({
      proxy: `${PROXY_HOST}:${PROXY_PORT}`,
      http_status: result.status,
      body_length: result.body.length,
      cookies: result.cookies,
      duration_ms: Date.now() - start,
      proxy_error: result.body.toLowerCase().includes('bad gateway'),
      ok: result.status === 200,
    });
  } catch (err) {
    res.json({
      proxy: `${PROXY_HOST}:${PROXY_PORT}`,
      error: err.message,
      duration_ms: Date.now() - start,
      ok: false,
      hint: '"socket hang up" = proxy unreachable (dead IP or wrong port). "407" = bad credentials. Fix env vars in Railway.',
    });
  }
});

// ─────────────────────────────────────────────────────────────
// /scrape  POST { name: "GARCIA ELVIA" } or { soid: "123456" }
// ─────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { name, soid } = req.body;
  if (!name && !soid) return res.status(400).json({ success: false, error: 'Provide name or soid' });

  const searchName = name ? formatName(name) : '';
  console.log(`[scrape] "${name || soid}" → "${searchName}"`);

  let browser;
  try {
    browser = await launchBrowser();

    console.log('[scrape] Step 1 — getting session cookie');
    const session = await withRetry(() => getSessionCookie(), 3, 3000);
    let cookies = session.cookies;
    console.log(`[scrape] Cookies: ${JSON.stringify(cookies.map(c => c.split(';')[0]))}`);

    console.log('[scrape] Step 2 — submitting search form');
    const formResult = await withRetry(() => submitSearchForm(cookies, searchName, soid), 2, 2000);
    cookies = formResult.cookies;

    let resultsHtml = formResult.body;
    if (formResult.status === 302 || formResult.status === 301) {
      const loc = formResult.location || '';
      const redirectUrl = loc.startsWith('http') ? loc : BASE_URL + loc;
      console.log(`[scrape] Redirect → ${redirectUrl}`);
      const redir = await getPage(redirectUrl, cookies, BASE_URL + '/inquiry.asp');
      resultsHtml = redir.body;
      cookies = redir.cookies;
    }
    console.log(`[scrape] Results HTML: ${resultsHtml.length} chars`);

    const { page: rPage, context: rCtx } = await parseHtml(browser, resultsHtml);
    const bodyText = await rPage.textContent('body').catch(() => '');
    const hasTable = (await rPage.$('table')) !== null;

    if (!hasTable || bodyText.toLowerCase().includes('no record') || bodyText.toLowerCase().includes('no match') || bodyText.toLowerCase().includes('not found')) {
      await rCtx.close(); await browser.close();
      console.log(`[scrape] No results for: ${searchName || soid}`);
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }

    const summaryRow = await rPage.evaluate(() => {
      for (const row of document.querySelectorAll('table tr')) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => (td.innerText || '').trim());
        if (cells.length >= 6 && cells[1] && cells[1].length > 2 && !cells[1].toLowerCase().includes('name') && !cells[1].toLowerCase().includes('image')) {
          return { name: cells[1]||'', dob: cells[2]||'', race: cells[3]||'', sex: cells[4]||'', location: cells[5]||'', soid: cells[6]||'', days_in_custody: cells[7]||'' };
        }
      }
      return null;
    });

    if (!summaryRow) {
      await rCtx.close(); await browser.close();
      return res.json({ success: true, found: false, name: name || soid, data: null });
    }
    console.log(`[scrape] Found: "${summaryRow.name}" SOID:${summaryRow.soid}`);

    const bookingInfo = await rPage.evaluate(() => {
      for (const form of document.querySelectorAll('form')) {
        const action = (form.action || form.getAttribute('action') || '').toLowerCase();
        if (!action.includes('inmdetails') && !action.includes('inm_details')) continue;
        const inputs = {};
        form.querySelectorAll('input').forEach(i => { inputs[(i.name||'').toUpperCase()] = i.value; });
        if (inputs['BOOKING_ID']) return { soid: inputs['SOID']||'', bookingId: inputs['BOOKING_ID'] };
      }
      const all = {};
      document.querySelectorAll('input').forEach(i => { all[(i.name||'').toUpperCase()] = i.value; });
      if (all['BOOKING_ID']) return { soid: all['SOID']||'', bookingId: all['BOOKING_ID'] };
      for (const a of document.querySelectorAll('a')) {
        const href = a.href || a.getAttribute('href') || '';
        if (href.toLowerCase().includes('inmdetails')) return { href };
      }
      return null;
    });

    await rCtx.close();
    console.log(`[scrape] bookingInfo: ${JSON.stringify(bookingInfo)}`);

    if (!bookingInfo || (!bookingInfo.bookingId && !bookingInfo.href)) {
      console.log('[scrape] No BOOKING_ID — returning summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name||soid) });
    }

    let detailUrl;
    if (bookingInfo.href) {
      detailUrl = bookingInfo.href.startsWith('http') ? bookingInfo.href : BASE_URL + '/' + bookingInfo.href.replace(/^\//, '');
    } else {
      const ds = (bookingInfo.soid || summaryRow.soid || '').trim();
      detailUrl = `${BASE_URL}/InmDetails.asp?soid=${encodeURIComponent(ds)}&BOOKING_ID=${encodeURIComponent(bookingInfo.bookingId)}`;
    }
    console.log(`[scrape] Step 4 — ${detailUrl}`);
    const detailResult = await getPage(detailUrl, cookies, BASE_URL + '/inquiry.asp');

    if (detailResult.body.includes('Error_Page') || detailResult.body.includes('Unauthorised')) {
      console.log('[scrape] Error page on detail — summary only');
      await browser.close();
      return res.json({ success: true, found: true, data: buildBasicData(summaryRow, name||soid) });
    }

    const { page: dPage, context: dCtx } = await parseHtml(browser, detailResult.body);
    const detail = await parseDetailPage(dPage);
    await dCtx.close();
    await browser.close();

    console.log(`[scrape] ✅ ${detail.full_name || summaryRow.name} | booking:${detail.booking_started} | charges:${detail.charges_description.substring(0,60)}`);
    return res.json({ success: true, found: true, detail_url: detailUrl, scraped_at: new Date().toISOString(), data: buildRecord(detail, summaryRow, name||soid) });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[scrape] ❌ "${name||soid}": ${err.message}`);
    return res.status(500).json({
      success: false, found: false, error: err.message, name: name||soid||'',
      hint: (err.message.includes('timed out') || err.message.includes('socket hang up'))
        ? 'Proxy is unreachable. Go to Railway → Variables and update PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS with a working proxy.'
        : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// PARSE DETAIL PAGE
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
        if (tr && tr.nextElementSibling) { const td = tr.nextElementSibling.querySelector('td, th'); if (td) return (td.innerText||'').trim(); }
      }
      return '';
    }
    function rowAfter(label) {
      const all = Array.from(document.querySelectorAll('td, th'));
      for (let i = 0; i < all.length; i++) {
        if ((all[i].innerText||'').trim().toLowerCase() !== label.toLowerCase()) continue;
        const tr = all[i].closest('tr');
        if (tr && tr.nextElementSibling) return Array.from(tr.nextElementSibling.querySelectorAll('td, th')).map(td => (td.innerText||'').trim());
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
      is_released:!bodyText.includes('Not Released')&&!location.toLowerCase().includes('jail'),
    };
  });
}

function buildRecord(detail, summaryRow, originalName) {
  const rsp=(detail.race_sex||'').replace(/\s/g,'').split('/');
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
    agency_id:detail.agency_id||'', charges_detail:detail.charges||[],
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
    race, sex, processed:false, locked:false, scraped_at:new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// /admissions
// ─────────────────────────────────────────────────────────────
app.post('/admissions', async (req, res) => {
  let browser;
  try {
    const session = await withRetry(() => getSessionCookie(), 3, 3000);
    const result  = await getPage(BASE_URL + '/inquiry.asp?soid=&inmate_name=&serial=&qry=Admissions', session.cookies, FORM_URL);
    browser = await launchBrowser();
    const { page, context } = await parseHtml(browser, result.body);
    await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
    const inmates = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => (c.innerText||'').trim());
        if (!cells[1]||cells[1].length<2) return null;
        return { name:cells[1]||'', dob:cells[2]||'', race:cells[3]||'', sex:cells[4]||'', location:cells[5]||'', soid:cells[6]||'', days_in_custody:cells[7]||'' };
      }).filter(Boolean)
    );
    await context.close(); await browser.close();
    res.json({ success:true, count:inmates.length, inmates });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success:false, error:err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cobb County Scraper on port ${PORT}`);
  console.log(`   Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`   Endpoints: GET /health  GET /proxy-test  POST /scrape  POST /admissions`);
});
```

---

That's everything. After pasting, **the most important step**: go to **Railway → your service → Variables** and add a working proxy:
```
PROXY_HOST = <new proxy ip>
PROXY_PORT = <port>
PROXY_USER = <username>
PROXY_PASS = <password>
