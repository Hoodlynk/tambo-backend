# Production image for the Tambo API. Build: docker build -t tambo-api .
# Runtime configuration is environment only (see docs/deploy.md); nothing
# secret is baked in, and .env is excluded by .dockerignore.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
# /api/health answers 503-class when the database is down, so the platform
# stops routing to an instance that cannot serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM, which server.ts handles
CMD ["node", "dist/server.js"]
