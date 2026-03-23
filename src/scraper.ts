import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { chromium as playwrightExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { ProxyRotator } from './proxy';
import { InmateData, Charge, ArrestCircumstances } from './types';

// Apply stealth plugin
playwrightExtra.use(stealth());

const BASE_URL = 'https://inmate-search.cobbsheriff.org';
const SEARCH_PAGE = '/enter_name.shtm';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '45000', 10);

export class CobbCountyInmateScraper {
  private browser: Browser | null = null;
  private proxyRotator: ProxyRotator;

  constructor(proxyUrls: string[]) {
    this.proxyRotator = new ProxyRotator(proxyUrls);
  }

  async init() {
    if (!this.browser) {
      this.browser = await playwrightExtra.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1280,800',
        ],
      });
    }
  }

  async scrape(name: string): Promise<{ found: boolean; data?: InmateData; error?: string }> {
    if (!this.browser) await this.init();

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      // Get proxy for this request
      const contextOptions = this.proxyRotator.getBrowserContextOptions();
      
      context = await this.browser!.newContext({
        ...contextOptions,
        viewport: { width: 1280, height: 800 },
        userAgent: this.getRandomUserAgent(),
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });

      // Block unnecessary resources
      await context.route('**/*.{png,jpg,jpeg,webp,gif,css,woff,woff2,svg}', route => route.abort());

      page = await context.newPage();
      
      // Set headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      });

      console.log(`🔍 Searching for: "${name}"`);

      // Step 1: Go to search page
      await page.goto(`${BASE_URL}${SEARCH_PAGE}`, { 
        waitUntil: 'networkidle', 
        timeout: REQUEST_TIMEOUT 
      });

      // Step 2: Fill in the name (format: Last First)
      await page.fill('input[name="inmate_name"]', name);
      
      // Select "Inquiry" from dropdown if exists
      try {
        await page.selectOption('select[name="qry"]', 'Inquiry');
      } catch (e) {
        // Dropdown might not exist or be hidden
      }

      // Step 3: Click Search button
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: REQUEST_TIMEOUT }),
        page.click('input[type="submit"][value="Search"], button:has-text("Search")'),
      ]);

      // Step 4: Check if we got results
      const currentUrl = page.url();
      
      // Check for "no results" message
      const pageText = await page.textContent('body');
      if (pageText.includes('No matching records') || pageText.includes('no records found')) {
        console.log(`❌ No results found for: "${name}"`);
        return { found: false };
      }

      // If we're on the results page (inquiry.asp), click "Last Known Booking"
      if (currentUrl.includes('inquiry.asp')) {
        try {
          // Click the "Last Known Booking" link/button
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: REQUEST_TIMEOUT }),
            page.click('text=Last Known Booking, text=Last Known Booking'),
          ]);
        } catch (e) {
          console.log('⚠️ Could not click "Last Known Booking", trying to extract from results table');
          // Try to extract SOID from results table and navigate manually
          const soId = await this.extractSOIDFromResults(page);
          if (soId) {
            await page.goto(`${BASE_URL}/InmDetails.asp?soid=${soId}&BOOKING_ID=`, {
              waitUntil: 'networkidle',
              timeout: REQUEST_TIMEOUT,
            });
          } else {
            return { found: false, error: 'Could not navigate to inmate details' };
          }
        }
      }

      // Step 5: Extract inmate data from details page
      const inmateData = await this.extractInmateData(page);
      
      if (!inmateData.soId && !inmateData.event_id) {
        console.log(`❌ Could not extract SOID/event_id for: "${name}"`);
        return { found: false, error: 'Could not extract required fields' };
      }

      // Ensure event_id is set (use SOID)
      if (!inmateData.event_id && inmateData.soId) {
        inmateData.event_id = inmateData.soId;
      }

      // Validate event_id is numeric
      const eventIdNum = Number(inmateData.event_id);
      if (Number.isNaN(eventIdNum)) {
        console.log(`⚠️ Non-numeric event_id: ${inmateData.event_id}, using as-is`);
      }

      console.log(`✅ Found inmate: ${inmateData.name} (SOID: ${inmateData.soId})`);
      return { found: true,  inmateData };

    } catch (err: any) {
      console.error(`❌ Scrape error for "${name}":`, err.message);
      return { 
        found: false, 
        error: err.message?.includes('timeout') ? 'Request timeout' : `Scraping failed: ${err.message}` 
      };
    } finally {
      if (context) await context.close();
    }
  }

  private async extractSOIDFromResults(page: Page): Promise<string | null> {
    try {
      // Look for SOID in the results table
      const soId = await page.evaluate(() => {
        // Try to find SOID in table cells
        const cells = Array.from(document.querySelectorAll('td'));
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          // SOID format: 001115049 (9 digits)
          if (/^\d{9}$/.test(text)) {
            return text;
          }
        }
        return null;
      });
      return soId;
    } catch (e) {
      return null;
    }
  }

  private async extractInmateData(page: Page): Promise<InmateData> {
    const data: InmateData = {
      event_id: '',
      soId: '',
    };

    try {
      // Extract all data using page evaluation
      const extracted = await page.evaluate(() => {
        const getText = (selector: string): string => {
          const el = document.querySelector(selector);
          return el?.textContent?.trim() || '';
        };

        const getCellValue = (label: string): string => {
          // Find label and get next cell value
          const labels = Array.from(document.querySelectorAll('th, td'));
          for (let i = 0; i < labels.length; i++) {
            if (labels[i].textContent?.toLowerCase().includes(label.toLowerCase())) {
              // Next cell or same row next cell
              const next = labels[i].nextElementSibling;
              if (next) return next.textContent?.trim() || '';
              // Try parent row next cell
              const parent = labels[i].parentElement;
              if (parent) {
                const cells = Array.from(parent.querySelectorAll('td'));
                const idx = cells.indexOf(labels[i] as HTMLTableCellElement);
                if (idx >= 0 && cells[idx + 1]) {
                  return cells[idx + 1].textContent?.trim() || '';
                }
              }
            }
          }
          return '';
        };

        // Extract URL parameters for SOID and BOOKING_ID
        const urlParams = new URLSearchParams(window.location.search);
        const soid = urlParams.get('soid') || '';
        const bookingId = urlParams.get('BOOKING_ID') || '';

        // Personal Information section
        const name = getCellValue('Name') || getText('td:has-text("RANKIN")');
        const dob = getCellValue('DOB');
        const raceSex = getCellValue('Race/Sex');
        const location = getCellValue('Location');
        const soIdCell = getCellValue('SOID');
        const daysInCustody = getCellValue('Days in Custody');
        const height = getCellValue('Height');
        const weight = getCellValue('Weight');
        const hair = getCellValue('Hair');
        const eyes = getCellValue('Eyes');
        const address = getCellValue('Address');
        const city = getCellValue('City');
        const state = getCellValue('State');
        const zip = getCellValue('Zip');
        const placeOfBirth = getCellValue('Place of Birth');

        // Booking Information
        const agencyId = getCellValue('Agency ID');
        const arrestDateTime = getCellValue('Arrest Date/Time');
        const bookingStarted = getCellValue('Booking Started');
        const bookingComplete = getCellValue('Booking Complete');

        // Visible Scars and Marks
        const visibleScarsMarks = getText('td:has-text("N/A")');

        // Arrest Circumstances
        const arrestAgency = getCellValue('Arrest Agency');
        const officer = getCellValue('Officer');
        const locationOfArrest = getCellValue('Location of Arrest');
        const serialNumber = getCellValue('Serial #');

        // Charges - extract all charge rows
        const charges: any[] = [];
        const chargeRows = document.querySelectorAll('tr');
        let currentCharge: any = null;

        for (const row of Array.from(chargeRows)) {
          const cells = Array.from(row.querySelectorAll('td, th'));
          const cellTexts = cells.map(c => c.textContent?.trim() || '');
          
          // Check for charge-related fields
          if (cellTexts.some(t => t.includes('Warrant') || t.includes('Case') || t.includes('Description'))) {
            if (currentCharge) charges.push(currentCharge);
            currentCharge = {};
          }

          if (currentCharge) {
            for (let i = 0; i < cells.length; i++) {
              const label = cells[i].textContent?.trim() || '';
              const value = cells[i + 1]?.textContent?.trim() || '';
              
              if (label.includes('Warrant') && !label.includes('Date')) currentCharge.warrant = value;
              if (label.includes('Warrant Date')) currentCharge.warrantDate = value;
              if (label === 'Case') currentCharge.case = value;
              if (label === 'OTN') currentCharge.otn = value;
              if (label.includes('Offense Date')) currentCharge.offenseDate = value;
              if (label.includes('Code Section')) currentCharge.codeSection = value;
              if (label === 'Description') currentCharge.description = value;
              if (label === 'Type') currentCharge.type = value;
              if (label === 'Counts') currentCharge.counts = value;
              if (label === 'Bond' && !label.includes('Amount') && !label.includes('Status')) currentCharge.bond = value;
              if (label === 'Disposition') currentCharge.disposition = value;
            }
          }
        }
        if (currentCharge) charges.push(currentCharge);

        // Bond Information
        const bondAmount = getCellValue('Bond Amount');
        const bondStatus = getCellValue('Bond Status');

        // Release Information
        const releaseDate = getCellValue('Release Date');
        const releaseOfficer = getCellValue('Officer'); // In release section
        const releasedTo = getCellValue('Released To');

        // Attorney
        const attorney = getText('td:has-text("No Attorney")');

        return {
          soId: soId || soIdCell,
          bookingId,
          name,
          dob,
          raceSex,
          location,
          daysInCustody,
          height,
          weight,
          hair,
          eyes,
          address,
          city,
          state,
          zip,
          placeOfBirth,
          agencyId,
          arrestDateTime,
          bookingStarted,
          bookingComplete,
          visibleScarsMarks,
          arrestAgency,
          officer,
          locationOfArrest,
          serialNumber,
          charges,
          bondAmount,
          bondStatus,
          releaseDate,
          releaseOfficer,
          releasedTo,
          attorney,
        };
      });

      // Merge extracted data
      Object.assign(data, extracted);

      // Clean up empty values
      Object.keys(data).forEach(key => {
        if (data[key] === '' || data[key] === null || data[key] === undefined) {
          delete data[key];
        }
      });

    } catch (err: any) {
      console.error('Error extracting data:', err.message);
    }

    return data;
  }

  private getRandomUserAgent(): string {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
