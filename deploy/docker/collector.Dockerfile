FROM node:26.8-bookworm AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/collector/package.json apps/collector/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/i18n/package.json packages/i18n/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY types types
RUN pnpm build

FROM node:26.8-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/apps/collector/src/main.js"]
