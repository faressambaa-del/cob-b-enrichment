FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Use npm install (works without lockfile) + install Playwright browsers
RUN npm install --omit=dev && \
    npx playwright install chromium --with-deps && \
    npm cache clean --force

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user (pwuser exists in Playwright base image)
USER pwuser

# Start application
CMD ["npm", "start"]
