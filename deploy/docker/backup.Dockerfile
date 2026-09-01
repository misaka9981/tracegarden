FROM node:26.8-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes awscli postgresql-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/backup.mjs /app/backup.mjs
USER node
ENTRYPOINT ["node", "/app/backup.mjs"]
