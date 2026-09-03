FROM postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7 AS postgres-runtime
FROM docker.io/oven/bun:1.3.14-slim@sha256:6068a9d40e9fc5c4519891edb63dfc5935c393fe2228eb9a5b7f472b444b5ee2

ENV NODE_ENV=production
WORKDIR /app
COPY --from=postgres-runtime /usr/local/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=postgres-runtime /usr/local/bin/pg_restore /usr/local/bin/pg_restore
COPY --from=postgres-runtime /usr/local/lib/libpq.so.5 /usr/local/lib/libpq.so.5
COPY --from=postgres-runtime /lib/ld-musl-aarch64.so.1 /lib/ld-musl-aarch64.so.1
COPY --from=postgres-runtime /usr/lib/libzstd.so.1 /usr/lib/libzstd.so.1
COPY --from=postgres-runtime /usr/lib/liblz4.so.1 /usr/lib/liblz4.so.1
COPY --from=postgres-runtime /usr/lib/libcrypto.so.3 /usr/lib/libcrypto.so.3
COPY --from=postgres-runtime /usr/lib/libz.so.1 /usr/lib/libz.so.1
COPY --from=postgres-runtime /usr/lib/libssl.so.3 /usr/lib/libssl.so.3
COPY --from=postgres-runtime /usr/lib/libgssapi_krb5.so.2 /usr/lib/libgssapi_krb5.so.2
COPY --from=postgres-runtime /usr/lib/libldap.so.2 /usr/lib/libldap.so.2
COPY --from=postgres-runtime /usr/lib/libkrb5.so.3 /usr/lib/libkrb5.so.3
COPY --from=postgres-runtime /usr/lib/libk5crypto.so.3 /usr/lib/libk5crypto.so.3
COPY --from=postgres-runtime /usr/lib/libcom_err.so.2 /usr/lib/libcom_err.so.2
COPY --from=postgres-runtime /usr/lib/libkrb5support.so.0 /usr/lib/libkrb5support.so.0
COPY --from=postgres-runtime /usr/lib/liblber.so.2 /usr/lib/liblber.so.2
COPY --from=postgres-runtime /usr/lib/libsasl2.so.3 /usr/lib/libsasl2.so.3
COPY --from=postgres-runtime /usr/lib/libkeyutils.so.1 /usr/lib/libkeyutils.so.1
COPY scripts/backup.mjs /app/backup.mjs
USER bun
ENTRYPOINT ["bun", "/app/backup.mjs"]
