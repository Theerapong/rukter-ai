FROM public.ecr.aws/docker/library/node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/Theerapong/rukter-ai" \
      org.opencontainers.image.title="Rukter.ai Launch Agent" \
      org.opencontainers.image.description="AMD Developer Hackathon ACT II Track 3 commerce launch agent"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3017

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY lib ./lib
COPY amd-worker ./amd-worker
COPY public ./public
COPY README.md SUBMISSION.md ./

EXPOSE 3017
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "server.mjs"]
