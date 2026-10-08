FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY web ./web
RUN useradd --create-home ferox && mkdir /data && chown ferox:ferox /data
USER ferox
ENV HOST=0.0.0.0 PORT=8788 FEROX_DATA=/data
EXPOSE 8788
CMD ["node", "src/server.mjs"]
