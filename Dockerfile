FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# Datos persistentes (machines.json) en un volumen, con un usuario sin privilegios
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]
