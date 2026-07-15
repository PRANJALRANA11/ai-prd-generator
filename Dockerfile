FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
