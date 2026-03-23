# Cobb County Inmate Scraper

Playwright-based scraper for Cobb County Sheriff's Office inmate records.

## Features

- ✅ Proxy rotation (Webshare.io compatible)
- ✅ Stealth mode to avoid detection
- ✅ Extracts complete inmate information
- ✅ RESTful API endpoint
- ✅ Docker-ready for Railway deployment
- ✅ Error handling and retry logic

## Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your proxy credentials
nano .env

# Run in development mode
npm run dev

# Or build and run
npm run build
npm start
