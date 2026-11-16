FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencies
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN chown node:node /app
USER node
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
RUN npm run build

FROM build AS tests
ENV NODE_ENV=test NPM_CONFIG_CACHE=/tmp/npm-cache
COPY --chown=node:node db ./db
COPY --chown=node:node tests ./tests
COPY --chown=node:node scripts/test-entrypoint.sh ./scripts/test-entrypoint.sh
RUN chmod 0555 ./scripts/test-entrypoint.sh
ENTRYPOINT ["/app/scripts/test-entrypoint.sh"]

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node db ./db
USER node
CMD ["node", "dist/api.js"]
