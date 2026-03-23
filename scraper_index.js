/**
 * Cobb County Inmate Scraper — Railway Microservice
 * 
 * Flow:
 *  POST /scrape { name: "RANKIN SHAWN" }
 *    1. GET inquiry.asp directly (skip homepage, go straight to results)
 *    2. Parse results table → extract inmate row(s)
 *    3. Click "Last Known Booking" → GET InmDetails.asp
 *    4. Parse all booking detail fields
 *    5. Return structured JSON
 * 
 *  GET /health → { status: "ok" }
 * 
 * Key fix: We use direct URL construction instead of navigating
 * the homepage, which times out. The search results page is reachable
 * directly via GET with query params.
 */

const express    = require('express');
const playwright = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ──────────────────────────────────────────────────────────────────
const BASE_URL    = 'http://inmate-search.cobbsheriff.org';
const RESULTS_URL = `${BASE_URL}/inquiry.asp`;
const TIMEOUT_MS  = 60_000; // 60s per page load
const MAX_RETRIES = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the results URL directly.
 * Matches exactly what the browser submits:
 *   inquiry.asp?soid=&inmate_name=rankin+shawn&serial=&qry=Inquiry
 */
function buildSearchUrl(name) {
  const encoded = encodeURIComponent(name.trim()).replace(/%20/g, '+');
  return `${RESULTS_URL}?soid=&inmate_name=${encoded}&serial=&qry=Inquiry`;
}

/**
 * Launch a browser with stealth settings to avoid bot detection.
 * Uses non-headless mode on Railway (headless: true) but with
 * a real user agent so the site doesn't block the request.
 */
async function launchBrowser() {
  return playwright.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

/**
 * Scrape a single page with retry logic.
 */
async function scrapeWithRetry(name, retries = MAX_RETRIES) {
  let browser;
  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      browser = await launchBrowser();
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        // Spoof referrer so requests look like they came from the search form
        extraHTTPHeaders: {
          Referer: `${BASE_URL}/enter_name.shtm`,
        },
      });
      const page = await context.newPage();

      const result = await doScrape(page, name);
      return result;

    } catch (err) {
      lastError = err;
      console.error(`[scrape] Attempt ${attempt} failed for "${name}":`, err.message);
      if (attempt <= retries) {
        await sleep(3000 * attempt); // back-off: 3s, 6s
      }
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  throw lastError;
}

/**
 * Core scrape logic — runs inside an open browser page.
 */
async function doScrape(page, name) {
  // ── Step 1: Load results page directly ──────────────────────────────────
  const searchUrl = buildSearchUrl(name);
  console.log(`[scrape] Fetching: ${searchUrl}`);

  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS,
  });

  // ── Step 2: Parse results table ──────────────────────────────────────────
  // Check for "no records" response
  const pageText = await page.textContent('body');
  if (
    pageText.includes('No matching records') ||
    pageText.includes('no records found') ||
    pageText.includes('0 records')
  ) {
    return { found: false, name, data: null };
  }

  // Parse the results table — get first matching inmate row
  const inmates = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    const results = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      // Results table has 9 columns: Image, Name, DOB, Race, Sex, Location, SOID, Days in Custody, Last Known Booking, Previous Bookings
      if (cells.length >= 8) {
        const nameText = cells[1]?.innerText?.trim();
        const dob      = cells[2]?.innerText?.trim();
        const race     = cells[3]?.innerText?.trim();
        const sex      = cells[4]?.innerText?.trim();
        const location = cells[5]?.innerText?.trim();
        const soid     = cells[6]?.innerText?.trim();
        const days     = cells[7]?.innerText?.trim();

        // Valid row must have a name (not the header row)
        if (nameText && nameText !== 'Name' && dob && soid) {
          // Find the "Last Known Booking" link
          const bookingLink = cells[8]?.querySelector('a, form, input[type=submit]');
          const bookingHref = bookingLink?.href || null;

          // Also check for a form action (the booking button is often a form submit)
          const form = cells[8]?.querySelector('form');
          const formAction = form ? form.action : null;

          // Extract booking ID from hidden inputs if present
          const hiddenInputs = {};
          if (form) {
            form.querySelectorAll('input[type=hidden], input:not([type])').forEach(input => {
              hiddenInputs[input.name] = input.value;
            });
          }

          results.push({
            name:          nameText,
            dob,
            race,
            sex,
            location,
            soid,
            days_in_custody: days,
            booking_href:  bookingHref,
            form_action:   formAction,
            hidden_inputs: hiddenInputs,
          });
        }
      }
    }
    return results;
  });

  if (!inmates || inmates.length === 0) {
    return { found: false, name, data: null };
  }

  const inmate = inmates[0]; // take first/best match
  console.log(`[scrape] Found inmate: ${inmate.name}, SOID: ${inmate.soid}`);

  // ── Step 3: Navigate to booking details ─────────────────────────────────
  // Try to click the "Last Known Booking" button/link in the table
  let bookingData = null;
  try {
    // Find and click the Last Known Booking button — it's the dark red button
    const bookingBtn = page.locator('input[value="Last Known Booking"], a:has-text("Last Known Booking"), input[type=submit]').first();
    
    if (await bookingBtn.count() > 0) {
      // Wait for navigation after click
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }),
        bookingBtn.click(),
      ]);
    } else if (inmate.soid && inmate.hidden_inputs?.BOOKING_ID) {
      // Fallback: construct the InmDetails URL directly
      const detailUrl = `${BASE_URL}/InmDetails.asp?soid=${encodeURIComponent(inmate.soid)}&BOOKING_ID=${inmate.hidden_inputs.BOOKING_ID}`;
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    } else {
      console.log(`[scrape] No booking button found for ${inmate.name}`);
    }

    // ── Step 4: Parse booking detail page ─────────────────────────────────
    bookingData = await parseBookingDetails(page);
    console.log(`[scrape] Booking details parsed for ${inmate.name}`);

  } catch (err) {
    console.error(`[scrape] Failed to get booking details for ${inmate.name}:`, err.message);
    // Return what we have from the results table even if booking detail fails
  }

  // ── Step 5: Assemble final record ────────────────────────────────────────
  const record = buildRecord(inmate, bookingData, name);
  return { found: true, name, data: record };
}

/**
 * Parse all fields from the InmDetails.asp booking detail page.
 * Extracts every table section visible in the screenshots:
 *   - Booking Information
 *   - Personal Information  
 *   - Visible Scars and Marks
 *   - Arrest Circumstances
 *   - Charges (one or more)
 *   - Release Information
 */
async function parseBookingDetails(page) {
  return page.evaluate(() => {
    const getText = el => el?.innerText?.trim() || null;

    // Helper: find a cell by its header label within a table
    const findCellAfterLabel = (label) => {
      const cells = Array.from(document.querySelectorAll('td'));
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].innerText?.trim().toLowerCase() === label.toLowerCase()) {
          return getText(cells[i + 1]);
        }
      }
      return null;
    };

    // Helper: get all rows from a named section table
    const getSectionRows = (sectionTitle) => {
      const headers = Array.from(document.querySelectorAll('td'));
      for (const hdr of headers) {
        if (hdr.innerText?.trim().toLowerCase().includes(sectionTitle.toLowerCase())) {
          const table = hdr.closest('table');
          if (table) {
            return Array.from(table.querySelectorAll('tr'))
              .map(r => Array.from(r.querySelectorAll('td')).map(c => getText(c)));
          }
        }
      }
      return [];
    };

    // ── Booking Information ──────────────────────────────────────────────
    const agencyId        = findCellAfterLabel('Agency ID');
    const arrestDateTime  = findCellAfterLabel('Arrest Date/Time');
    const bookingStarted  = findCellAfterLabel('Booking Started');
    const bookingComplete = findCellAfterLabel('Booking Complete');

    // ── Personal Information ─────────────────────────────────────────────
    const fullName        = findCellAfterLabel('Name');
    const dob             = findCellAfterLabel('DOB');
    const raceSex         = findCellAfterLabel('Race/Sex');
    const location        = findCellAfterLabel('Location');
    const soid            = findCellAfterLabel('SOID');
    const daysInCustody   = findCellAfterLabel('Days in Custody');
    const height          = findCellAfterLabel('Height');
    const weight          = findCellAfterLabel('Weight');
    const hair            = findCellAfterLabel('Hair');
    const eyes            = findCellAfterLabel('Eyes');
    const address         = findCellAfterLabel('Address');
    const city            = findCellAfterLabel('City');
    const state           = findCellAfterLabel('State');
    const zip             = findCellAfterLabel('Zip');
    const placeOfBirth    = findCellAfterLabel('Place of Birth');

    // ── Visible Scars & Marks ────────────────────────────────────────────
    const scarsMarks      = findCellAfterLabel('Visible Scars and Marks');

    // ── Arrest Circumstances ─────────────────────────────────────────────
    const arrestAgency    = findCellAfterLabel('Arrest Agency');
    const officer         = findCellAfterLabel('Officer');
    const locationOfArrest = findCellAfterLabel('Location of Arrest');
    const serial          = findCellAfterLabel('Serial #');

    // ── Charges (there can be multiple) ─────────────────────────────────
    // Charges are grouped in repeating table blocks
    const charges = [];
    const allCells = Array.from(document.querySelectorAll('td'));
    
    // Find all "Warrant" label cells — each one starts a new charge block
    for (let i = 0; i < allCells.length; i++) {
      if (allCells[i].innerText?.trim() === 'Warrant') {
        const charge = {
          warrant:       getText(allCells[i + 1]),
          warrant_date:  null,
          case_number:   null,
          otn:           null,
          offense_date:  null,
          code_section:  null,
          description:   null,
          type:          null,
          counts:        null,
          bond_per_charge: null,
          disposition:   null,
          bond_amount:   null,
          bond_status:   null,
        };

        // Look ahead in the same region for related fields
        for (let j = i + 1; j < Math.min(i + 60, allCells.length); j++) {
          const label = allCells[j].innerText?.trim();
          if (label === 'Warrant Date')   charge.warrant_date   = getText(allCells[j + 1]);
          if (label === 'Case')           charge.case_number    = getText(allCells[j + 1]);
          if (label === 'OTN')            charge.otn            = getText(allCells[j + 1]);
          if (label === 'Offense Date')   charge.offense_date   = getText(allCells[j + 2]); // skip Code Section header
          if (label === 'Code Section')   charge.code_section   = getText(allCells[j + 1]);
          if (label === 'Description')    charge.description    = getText(allCells[j + 1]);
          if (label === 'Type')           charge.type           = getText(allCells[j + 1]);
          if (label === 'Counts')         charge.counts         = getText(allCells[j + 1]);
          if (label === 'Bond')           charge.bond_per_charge = getText(allCells[j + 1]);
          if (label === 'Disposition')    charge.disposition    = getText(allCells[j + 1]);
          if (label === 'Bond Amount')    charge.bond_amount    = getText(allCells[j + 1]);
          if (label === 'Bond Status')    charge.bond_status    = getText(allCells[j + 2]);
          // Stop when we hit the next "Warrant" label (next charge)
          if (label === 'Warrant' && j > i + 1) break;
        }
        charges.push(charge);
      }
    }

    // ── Release Information ──────────────────────────────────────────────
    const attorney      = findCellAfterLabel('Attorney');
    const releaseDate   = findCellAfterLabel('Release Date');
    const releaseOfficer = findCellAfterLabel('Officer');
    const releasedTo    = findCellAfterLabel('Released To');

    // ── Booking ID from URL ──────────────────────────────────────────────
    const urlParams   = new URLSearchParams(window.location.search);
    const bookingId   = urlParams.get('BOOKING_ID');
    const soidFromUrl = urlParams.get('soid')?.trim();

    return {
      booking_id:       bookingId,
      agency_id:        agencyId,
      arrest_datetime:  arrestDateTime,
      booking_started:  bookingStarted,
      booking_complete: bookingComplete,
      full_name:        fullName,
      dob,
      race_sex:         raceSex,
      location,
      soid:             soid || soidFromUrl,
      days_in_custody:  daysInCustody,
      height,
      weight,
      hair,
      eyes,
      address,
      city,
      state,
      zip,
      place_of_birth:   placeOfBirth,
      scars_marks:      scarsMarks,
      arrest_agency:    arrestAgency,
      officer,
      location_of_arrest: locationOfArrest,
      serial,
      charges,
      attorney,
      release_date:     releaseDate,
      release_officer:  releaseOfficer,
      released_to:      releasedTo,
      detail_url:       window.location.href,
    };
  });
}

/**
 * Merge results-table data and booking-detail data into one clean record.
 * Uses booking detail as primary source of truth; falls back to results table.
 */
function buildRecord(inmate, bookingData, searchedName) {
  const now = new Date().toISOString();

  // Parse race and sex from "B /M" format
  let race = null, sex = null;
  const raceSexRaw = bookingData?.race_sex || `${inmate.race} ${inmate.sex}`;
  if (raceSexRaw) {
    const parts = raceSexRaw.replace(/\s+/g, ' ').split('/');
    race = parts[0]?.trim() || inmate.race;
    sex  = parts[1]?.trim() || inmate.sex;
  }

  // Use BOOKING_ID as event_id (primary key for Supabase upsert)
  const event_id = bookingData?.booking_id || null;

  return {
    event_id,
    searched_name:    searchedName,
    full_name:        bookingData?.full_name        || inmate.name,
    dob:              bookingData?.dob              || inmate.dob,
    race,
    sex,
    location:         bookingData?.location         || inmate.location,
    soid:             bookingData?.soid             || inmate.soid,
    days_in_custody:  bookingData?.days_in_custody  || inmate.days_in_custody,
    height:           bookingData?.height           || null,
    weight:           bookingData?.weight           || null,
    hair:             bookingData?.hair             || null,
    eyes:             bookingData?.eyes             || null,
    address:          bookingData?.address          || null,
    city:             bookingData?.city             || null,
    state:            bookingData?.state            || null,
    zip:              bookingData?.zip              || null,
    place_of_birth:   bookingData?.place_of_birth   || null,
    scars_marks:      bookingData?.scars_marks       || null,
    agency_id:        bookingData?.agency_id         || null,
    arrest_datetime:  bookingData?.arrest_datetime   || null,
    booking_started:  bookingData?.booking_started   || null,
    booking_complete: bookingData?.booking_complete  || null,
    arrest_agency:    bookingData?.arrest_agency     || null,
    officer:          bookingData?.officer           || null,
    location_of_arrest: bookingData?.location_of_arrest || null,
    serial:           bookingData?.serial            || null,
    charges:          bookingData?.charges           || [],
    attorney:         bookingData?.attorney          || null,
    release_date:     bookingData?.release_date      || null,
    release_officer:  bookingData?.release_officer   || null,
    released_to:      bookingData?.released_to       || null,
    detail_url:       bookingData?.detail_url        || null,
    scraped_at:       now,
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Express Routes ───────────────────────────────────────────────────────────

app.use(express.json());

// Health check — used by n8n as pre-flight gate
app.get('/health', async (req, res) => {
  // Also test that the target site is reachable
  try {
    const browser = await launchBrowser();
    const page    = await (await browser.newContext()).newPage();
    await page.goto(
      `${RESULTS_URL}?soid=&inmate_name=TEST&serial=&qry=Inquiry`,
      { waitUntil: 'domcontentloaded', timeout: 15_000 }
    );
    await browser.close();
    res.json({ status: 'ok', target_reachable: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', target_reachable: false, error: err.message });
  }
});

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  const { name } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'name is required (string)' });
  }

  console.log(`[scrape] Starting scrape for: "${name}"`);

  try {
    const result = await scrapeWithRetry(name.trim());
    console.log(`[scrape] Done. Found: ${result.found}`);
    return res.json({ success: true, found: result.found, data: result.data });
  } catch (err) {
    console.error(`[scrape] ❌ "${name}": ${err.message}`);
    return res.status(500).json({
      success: false,
      found: false,
      error: err.message,
      data: null,
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Cobb County scraper running on port ${PORT}`);
});
