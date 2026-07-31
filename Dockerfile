# Playwright's own image, pinned to the installed driver version. Chromium and
# its ~90 shared libraries are already present and version-matched, which is
# both faster and less brittle than `playwright install --with-deps` on top of
# a bare node image.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    TZ=Asia/Dubai \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Dependencies as their own layer so a source-only change does not reinstall.
COPY package.json package-lock.json ./
# `npm ci --omit=dev` would drop tsx, which is how the app runs. Keep dev deps
# and trim the cache instead.
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# Fail the build rather than the 06:00 run.
RUN npx tsc -p tsconfig.json --noEmit

# 1 GB container against a Chromium peak near 865 MB. Cap the old-space so V8
# gives back memory under pressure instead of racing the OOM killer.
ENV NODE_OPTIONS=--max-old-space-size=768

CMD ["npm", "run", "scheduler"]
