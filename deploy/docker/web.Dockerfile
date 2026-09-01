FROM node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cluster/package.json packages/cluster/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/identity/package.json packages/identity/package.json
COPY packages/logs/package.json packages/logs/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages/cluster packages/cluster
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY packages/i18n packages/i18n
COPY packages/identity packages/identity
COPY packages/logs packages/logs
COPY packages/telemetry packages/telemetry
COPY scripts/build.mjs scripts/build.mjs
COPY types types
RUN CI=true pnpm build && CI=true pnpm prune --prod

FROM node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/dist/apps/web ./dist/apps/web
COPY --from=build /workspace/dist/packages ./dist/packages
COPY --from=build /workspace/node_modules ./node_modules
RUN find /app/dist -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' \) -delete \
  && find /app/node_modules -type l -xtype l -delete \
  && rm -rf /app/node_modules/.pnpm/node_modules/.bin /app/node_modules/.pnpm/node_modules/@typescript
USER node
EXPOSE 3000
CMD ["node", "dist/apps/web/src/main.js"]
