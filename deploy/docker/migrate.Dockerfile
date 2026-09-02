FROM node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89
WORKDIR /app
ENV NODE_ENV=production
COPY --from=frozen /dist/apps/migrate ./dist/apps/migrate
COPY --from=frozen /dist/packages ./dist/packages
COPY --from=frozen /node_modules ./node_modules
RUN find /app/dist -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' \) -delete \
  && rm -rf /app/node_modules/.bin /app/node_modules/.pnpm/node_modules/.bin /app/node_modules/.pnpm/node_modules/@typescript \
  && find /app/node_modules -type l -xtype l -delete
USER node
CMD ["node", "dist/apps/migrate/src/main.js"]
