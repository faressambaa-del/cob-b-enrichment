FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Install Playwright browsers (Chromium only — smaller image)
RUN npx playwright install chromium --with-deps

# Copy source
COPY index.js ./

# Railway sets PORT automatically
ENV PORT=3000
EXPOSE 3000

# Health check so Railway knows when the service is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
