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
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/db/node_modules ./dist/packages/db/node_modules
RUN ln -s .pnpm/pg@8.20.0/node_modules/pg ./node_modules/pg
USER node
EXPOSE 3000
CMD ["node", "dist/apps/web/src/main.js"]
