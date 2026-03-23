FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy lockfile + package.json for deterministic installs
COPY package*.json ./

# Clean install using lockfile + install Playwright browsers
RUN npm ci --omit=dev && \
    npx playwright install chromium --with-deps && \
    npm cache clean --force

# Copy source
COPY . .

# Build
RUN npm run build

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

# Security: run as non-root
USER pwuser

CMD ["npm", "start"]
