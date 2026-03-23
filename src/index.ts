import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { z } from 'zod';
import { CobbCountyInmateScraper } from './scraper';
import { ScrapResponse } from './types';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request validation schema
const ScrapRequestSchema = z.object({
  name: z.string().min(1).max(100),
});

// Initialize scraper with proxy list
const proxyUrls = [
  process.env.PROXY_1_URL,
  process.env.PROXY_2_URL,
  process.env.PROXY_3_URL,
  process.env.PROXY_4_URL,
  process.env.PROXY_5_URL,
].filter(Boolean) as string[];

const scraper = new CobbCountyInmateScraper(proxyUrls);

// Health check endpoint
app.get('/', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'Cobb County Inmate Scraper',
    timestamp: new Date().toISOString(),
    proxiesConfigured: proxyUrls.length 
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scraping endpoint
app.post('/scrape', async (req: Request, res: Response<ScrapResponse>) => {
  const startTime = Date.now();
  
  try {
    // Validate request
    const { name } = ScrapRequestSchema.parse(req.body);
    console.log(`[API] Received request for: "${name}"`);

    // Execute scrape
    const result = await scraper.scrape(name);
    
    const response: ScrapResponse = {
      success: true,
      found: result.found,
      ...(result.found && result.data && {  result.data }),
      ...(result.error && { error: result.error }),
    };

    console.log(`[API] "${name}" -> found: ${result.found}, time: ${Date.now() - startTime}ms`);
    res.json(response);

  } catch (err: any) {
    console.error('[API ERROR]', err.message);
    
    const response: ScrapResponse = {
      success: false,
      found: false,
      error: err.message || 'Internal server error',
    };
    
    res.status(500).json(response);
  }
});

// Batch scraping endpoint (optional)
app.post('/scrape/batch', async (req: Request, res: Response) => {
  try {
    const { names } = req.body;
    
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names array is required' });
    }

    const results = [];
    for (const name of names) {
      const result = await scraper.scrape(name);
      results.push({ name, ...result });
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.json({ success: true, results });
  } catch (err: any) {
    console.error('[BATCH ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('👋 Shutting down gracefully...');
  await scraper.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('👋 Shutting down...');
  await scraper.close();
  process.exit(0);
});

// Start server
async function start() {
  try {
    // Pre-warm browser
    await scraper.init();
    console.log('✅ Browser initialized');
  } catch (err: any) {
    console.warn('⚠️ Browser init warning:', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Cobb County Inmate Scraper running');
    console.log(`🔗 Endpoint: POST http://localhost:${PORT}/scrape`);
    console.log(`🌐 Proxies configured: ${proxyUrls.length > 0 ? 'YES' : 'NO'}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
  });
}

start();
