import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, sleep } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
const {
    name          = '',
    soid          = '',
    serial        = '',
    mode          = 'Inquiry',
    proxyUsername = '',
    proxyPassword = '',
    proxyList     = [],
} = input || {};

const proxyUrls = proxyList.map(p => `http://${proxyUsername}:${proxyPassword}@${p}`);

const INQUIRY_URL = [
    'http://inmate-search.cobbsheriff.org/inquiry.asp',
    `?soid=${encodeURIComponent(soid)}`,
    `&inmate_name=${encodeURIComponent(name)}`,
    `&serial=${encodeURIComponent(serial)}`,
    `&qry=${encodeURIComponent(mode)}`,
].join('');

console.log(`Searching → name="${name}"  mode="${mode}"`);

let result = {
    found         : false,
    name,
    mode,
    scrapedAt     : new Date().toISOString(),
    gotDetailPage : false,
    pageData      : { allRows: [] },
    debugInfo     : {},
};

const proxyConfiguration = proxyUrls.length > 0
    ? new ProxyConfiguration({ proxyUrls })
    : undefined;

const crawler = new PlaywrightCrawler({

    ...(proxyConfiguration ? { proxyConfiguration } : {}),

    launchContext: {
        launchOptions: {
            headless : true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.setExtraHTTPHeaders({
                'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language' : 'en-US,en;q=0.9',
            });
        },
    ],

    requestHandlerTimeoutSecs : 300,
    navigationTimeoutSecs     : 90,
    maxRequestRetries         : 2,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForLoadState('networkidle', { timeout: 60000 });
        await sleep(3000);

        const pageText = (await page.textContent('body')) || '';

        if (/no record/i.test(pageText) || /not found/i.test(pageText)) {
            log.info('No inmate record found.');
            result.found = false;
            return;
        }

        result.found = true;

        // ── Override window.open to intercept the popup URL ───────────────────
        // The sh() function calls window.open(url, ...) — we capture that URL
        // instead of letting it open a new window
        let capturedUrl = await page.evaluate(() => {
            return new Promise((resolve) => {
                // Override window.open to capture the URL
                const original = window.open;
                window.open = (url) => {
                    resolve(url);
                    return null;
                };

                // Find the Last Known Booking button and click it
                const buttons = Array.from(document.querySelectorAll('button'));
                const bookingBtn = buttons.find(b =>
                    /last/i.test(b.innerText) || /booking/i.test(b.innerText)
                );

                if (bookingBtn) {
                    bookingBtn.click();
                } else {
                    resolve(null);
                }

                // Timeout fallback
                setTimeout(() => resolve(null), 3000);
            });
        });

        log.info(`Captured popup URL: ${capturedUrl}`);

        // ── Also try extracting from raw HTML as backup ───────────────────────
        if (!capturedUrl) {
            const html = await page.content();
            // Match InmDetails URL in raw HTML (handles &amp; encoding)
            const match = html.match(/InmDetails\.asp\?[^"'<>]+/);
            if (match) {
                capturedUrl = match[0].replace(/&amp;/g, '&');
                log.info(`Extracted from HTML: ${capturedUrl}`);
            }
        }

        if (capturedUrl) {
            const base = 'http://inmate-search.cobbsheriff.org/';
            const fullUrl = capturedUrl.startsWith('http') ? capturedUrl : base + capturedUrl;
            log.info(`Navigating to detail page: ${fullUrl}`);

            await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 90000 });
            await sleep(3000);
            log.info(`Now on: ${page.url()}`);
        } else {
            log.warning('Could not find detail URL — scraping current page');
        }

        // ── Scrape the full booking detail page ───────────────────────────────
        const finalText = (await page.textContent('body')) || '';
        log.info(`Final URL: ${page.url()}`);
        log.info(`Final preview: ${finalText.substring(0, 500)}`);

        result.gotDetailPage = true;

        const allRows = await page.evaluate(() => {
            const rows = [];
            document.querySelectorAll('table').forEach(tbl => {
                tbl.querySelectorAll('tr').forEach(tr => {
                    const cells = Array.from(tr.querySelectorAll('td, th'))
                        .map(td => td.innerText?.trim() || '');
                    if (cells.some(c => c.length > 0)) rows.push(cells);
                });
            });
            return rows;
        });

        const fullText           = await page.evaluate(() => document.body.innerText);
        result.pageData.allRows  = allRows;
        result.pageData.fullText = fullText;
        result.debugInfo.rowCount  = allRows.length;
        result.debugInfo.finalUrl  = page.url();
        result.debugInfo.capturedUrl = capturedUrl;

        log.info(`✅ Scraped ${allRows.length} rows from: ${page.url()}`);
        log.info(`Sample rows: ${JSON.stringify(allRows.slice(0, 5))}`);
    },

    failedRequestHandler({ request, error, log }) {
        log.error(`Failed: ${request.url} — ${error?.message}`);
        result.debugInfo.error = error?.message;
    },
});

await crawler.run([{ url: INQUIRY_URL }]);

await Actor.pushData(result);
console.log('Done. found =', result.found, '| gotDetailPage =', result.gotDetailPage);
if (result.debugInfo.error) console.log('Error:', result.debugInfo.error);

await Actor.exit();
