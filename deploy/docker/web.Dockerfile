FROM docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2
WORKDIR /app
ENV NODE_ENV=production
COPY --from=frozen /dist/apps/web ./dist/apps/web
COPY --from=frozen /dist/packages ./dist/packages
COPY --from=frozen /node_modules ./node_modules
RUN find /app/dist -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' \) -delete \
  && rm -rf /app/node_modules/.bin /app/node_modules/.pnpm/node_modules/.bin /app/node_modules/.pnpm/node_modules/@typescript \
  && find /app/node_modules -type l -xtype l -delete
USER bun
EXPOSE 3000
CMD ["bun", "dist/apps/web/src/bun.js"]
