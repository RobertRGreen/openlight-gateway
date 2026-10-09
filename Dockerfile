FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/app/data/openlight.sqlite HUBSPACE_TOKEN_FILE=/app/data/hubspace-token.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# node is uid 1000, matching robert on the host so the bind-mounted data dir stays writable.
USER node
CMD ["node", "dist/service/main.js"]
