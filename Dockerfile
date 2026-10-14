# Speculative MCP proxy in a container.
#
#   docker build -t speculate-tools .
#   docker run -i --rm speculate-tools -- npx -y @modelcontextprotocol/server-filesystem /data
#
# The container speaks MCP over stdin/stdout (`-i` is required). Everything after `--` is the
# upstream stdio MCP server, started inside the container.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY README.md LICENSE CHANGELOG.md SECURITY.md ./
COPY docs ./docs
RUN npm run build && npm pack --ignore-scripts && mv speculate-tools-*.tgz /speculate-tools.tgz

FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production
COPY --from=build /speculate-tools.tgz /tmp/speculate-tools.tgz
RUN npm install --global --omit=dev /tmp/speculate-tools.tgz \
  && rm /tmp/speculate-tools.tgz \
  && npm cache clean --force
USER node
WORKDIR /home/node
ENTRYPOINT ["speculate-tools", "mcp-proxy"]
CMD ["--help"]
