FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@shotlin/api..." run build \
  && pnpm --filter "@shotlin/worker..." run build

ENV NODE_ENV=production

# Railway's API service uses this default. Its worker service uses the same
# image with this command overridden to `pnpm --filter @shotlin/worker start`.
CMD ["pnpm", "--filter", "@shotlin/api", "start"]
