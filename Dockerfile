# Playwright's own image, pinned to the installed driver version. Chromium and
# its shared libraries are already present and version-matched, which is both
# faster and less brittle than `playwright install --with-deps` on a bare node
# image. It also carries no compiler toolchain — fine, because nothing here
# builds a native addon.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV TZ=Asia/Dubai \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# NODE_ENV is deliberately NOT set to production here: the app runs TypeScript
# through tsx, so tsx and typescript are needed at runtime, and npm would omit
# them as devDependencies. It is set after the install instead.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# The local binary, not `npx tsc` — npx would miss the local install and fetch
# the unrelated `tsc` package from the registry, which is not the compiler.
RUN ./node_modules/.bin/tsc -p tsconfig.json --noEmit

# 1 GB container against a Chromium peak near 865 MB. Cap V8's old space so it
# gives memory back under pressure instead of racing the OOM killer.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=768

CMD ["npm", "run", "scheduler"]
