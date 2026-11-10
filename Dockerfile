# One multi-stage build for the monorepo. Targets: api, worker, dashboard.
FROM node:20.19-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# sdk is built too: the API serves it at /sdk.js
RUN pnpm turbo run build --filter=@growthos/api --filter=@growthos/worker --filter=@growthos/sdk

FROM build AS api
ENV NODE_ENV=production
WORKDIR /repo/services/api
EXPOSE 4000
# migrate + seed the dev org/demo site, then start (all idempotent)
CMD ["sh", "-c", "node ../../packages/db/dist/cli/migrate.js && node ../../packages/db/dist/cli/seed.js && node dist/main.js"]

FROM build AS worker
ENV NODE_ENV=production
WORKDIR /repo/services/worker
CMD ["node", "dist/main.js"]

FROM build AS dashboard-build
ARG VITE_API_URL=http://localhost:4000
ARG VITE_DEV_KEY
ENV VITE_API_URL=$VITE_API_URL VITE_DEV_KEY=$VITE_DEV_KEY
RUN pnpm --filter @growthos/dashboard exec vite build

FROM nginx:1.27-alpine AS dashboard
COPY docker/nginx-dashboard.conf /etc/nginx/conf.d/default.conf
COPY --from=dashboard-build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
