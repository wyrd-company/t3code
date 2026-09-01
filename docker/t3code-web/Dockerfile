# syntax=docker/dockerfile:1.7
# ---
# relationships:
#   builds: apps/web
#   uses:
#     - docker/t3code-web/nginx.conf
#     - LICENSE
# ---

ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NODE_IMAGE} AS build

ARG T3CODE_VERSION
ARG VITE_PLUS_VERSION=0.2.2

RUN test -n "${T3CODE_VERSION}" \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates g++ git make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY . .

RUN npm install --global "vite-plus@${VITE_PLUS_VERSION}" \
    && vp install --filter '@t3tools/scripts...' --filter '@t3tools/web...'

RUN APP_VERSION="${T3CODE_VERSION}" \
    T3CODE_WEB_SOURCEMAP=false \
    VITE_HOSTED_APP_CHANNEL=latest \
    vp run --filter @t3tools/web build \
    && VITE_HOSTED_APP_CHANNEL=latest \
    node scripts/apply-web-brand-assets.ts

FROM ${NGINX_IMAGE} AS runtime

ARG T3CODE_VERSION

LABEL org.opencontainers.image.title="T3 Code web client" \
    org.opencontainers.image.description="Unmodified static T3 Code web client" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/pingdotgg/t3code" \
    org.opencontainers.image.version="${T3CODE_VERSION}"

COPY docker/t3code-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist/ /usr/share/nginx/html/
COPY --from=build /src/LICENSE /usr/share/licenses/t3code/LICENSE

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
