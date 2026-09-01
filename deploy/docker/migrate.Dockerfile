FROM node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY packages/cluster/package.json packages/cluster/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/identity/package.json packages/identity/package.json
RUN pnpm install --frozen-lockfile
COPY apps/migrate apps/migrate
COPY packages/cluster packages/cluster
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY packages/identity packages/identity
COPY scripts/build.mjs scripts/build.mjs
COPY types types
RUN CI=true pnpm build && CI=true pnpm prune --prod

FROM node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/dist/apps/migrate ./dist/apps/migrate
COPY --from=build /workspace/dist/packages ./dist/packages
COPY --from=build /workspace/node_modules ./node_modules
RUN find /app/dist -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' \) -delete \
  && find /app/node_modules -type l -xtype l -delete \
  && rm -rf /app/node_modules/.pnpm/node_modules/.bin /app/node_modules/.pnpm/node_modules/@typescript
USER node
CMD ["node", "dist/apps/migrate/src/main.js"]
