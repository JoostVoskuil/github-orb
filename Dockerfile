FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p dist/sdcard && cp firmware/data/animations.orb firmware/data/sounds.json dist/sdcard/

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ORB_DASHBOARD_HOST=0.0.0.0 \
    ORB_DASHBOARD_PORT=7420 \
    ORB_USB_SETUP=off \
    ORB_DATA_DIR=/data \
    COPILOT_HOME=/copilot-home

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dashboard ./dashboard
COPY --from=build --chown=node:node /app/media/animations ./media/animations
COPY --from=build --chown=node:node /app/media/images ./media/images
COPY --from=build --chown=node:node /app/protocol ./protocol
RUN mkdir -p /data /copilot-home/orb /copilot-home/extensions && chown -R node:node /data /copilot-home

USER node
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7420/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/dashboard/serve.js"]
