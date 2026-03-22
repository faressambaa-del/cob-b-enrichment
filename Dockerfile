# Use official Playwright image with browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Install Chromium browser
RUN npx playwright install chromium

# Copy application code
COPY server.js ./

# Expose port (Railway sets PORT env var automatically)
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
