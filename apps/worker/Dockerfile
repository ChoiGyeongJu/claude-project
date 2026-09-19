FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @app/worker exec tsc -p tsconfig.json

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/package.json ./apps/worker/
USER node
CMD ["node", "apps/worker/dist/main.js"]
