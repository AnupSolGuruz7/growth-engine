# postgres:16-alpine + pgvector, built from source.
# Kept on the same Alpine base as the original image on purpose: swapping to the Debian-based
# pgvector/pgvector image would change the C library (musl -> glibc) under an existing data
# volume, and text collation differences between the two silently corrupt text indexes.
FROM postgres:16-alpine
ARG PGVECTOR_VERSION=0.8.0
RUN apk add --no-cache --virtual .build-deps git build-base \
 && git clone --depth 1 --branch v${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && cd /tmp/pgvector \
 && make with_llvm=no OPTFLAGS="" \
 && make with_llvm=no install \
 && cd / && rm -rf /tmp/pgvector \
 && apk del .build-deps
