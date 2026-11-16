FROM ghcr.io/puppeteer/puppeteer:24.38.0@sha256:bcb4fd4543ceee3a6b8b9a81403ed4c09ae316dca8b857773cf67328c0c2ee3c AS browser

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

FROM browser AS build
USER root
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM browser AS runtime
USER root
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /data/wwebjs-auth /app/.wwebjs_cache \
    && chown -R pptruser:pptruser /data/wwebjs-auth /app
COPY --from=build --chown=pptruser:pptruser /app/package.json ./package.json
COPY --from=build --chown=pptruser:pptruser /app/package-lock.json ./package-lock.json
COPY --from=build --chown=pptruser:pptruser /app/node_modules ./node_modules
COPY --from=build --chown=pptruser:pptruser /app/dist ./dist
USER pptruser
CMD ["node", "dist/gateway.js"]
