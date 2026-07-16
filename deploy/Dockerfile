# Build Hub workspaces; runtime image ships CLI entrypoint for `shepaw-hub web`.
FROM node:20-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY sdks/shepaw-acp-sdk-typescript/package.json sdks/shepaw-acp-sdk-typescript/
COPY implementations/acp-proxy-ts/package.json implementations/acp-proxy-ts/
COPY agent-hub/core/package.json agent-hub/core/
COPY agent-hub/api/package.json agent-hub/api/
COPY agent-hub/ui/package.json agent-hub/ui/
COPY agent-hub/cli/package.json agent-hub/cli/
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    SHEPAW_HUB_HOME=/data/shepaw-hub
COPY --from=build /src /app
RUN npm ci --omit=dev
VOLUME ["/data/shepaw-hub"]
EXPOSE 4000 18789 18793
# Prefer the built CLI entry (same as docs/deployment.md «方式 B»).
CMD ["node", "agent-hub/cli/dist/cli.js", "web", "--host", "127.0.0.1", "--port", "4000", "--no-open"]
