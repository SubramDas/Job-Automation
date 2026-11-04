FROM node:20-bookworm

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install project dependencies
RUN npm install

# Install Playwright Chromium with system dependencies
RUN npx playwright install --with-deps chromium

# Copy the rest of the application code
COPY . .

# Render binds to PORT (default 10000)
EXPOSE 10000

CMD ["node", "scripts/render-bot.mjs"]
