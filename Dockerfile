FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app/ ./
ARG RFQ_BASE_PATH=/quanta-rfq/
ENV RFQ_BASE_PATH=$RFQ_BASE_PATH
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV RFQ_BASE_PATH=/quanta-rfq/ NODE_ENV=production RFQ_WEB_HOST=0.0.0.0 RFQ_WEB_PORT=3000 RFQ_DB_PATH=/data/inventory.sqlite
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public/data ./public/data
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server/web.mjs"]
