FROM docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981
WORKDIR /app
ENV NODE_ENV=production \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=frozen /dist/apps/collector ./dist/apps/collector
COPY --from=frozen /dist/packages ./dist/packages
COPY --from=frozen /node_modules ./node_modules
USER nonroot
EXPOSE 3001
CMD ["dist/apps/collector/src/main.js"]
