# Use Apify's official Playwright Docker image — this includes Playwright + browsers pre-installed
FROM apify/actor-node-playwright-chrome:20

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the actor files
COPY . ./

# Run the actor
CMD npm start
