FROM node:22-alpine
WORKDIR /app
COPY server/ ./server/
COPY web/ ./web/
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data WEB_DIR=/app/web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/server.js"]
