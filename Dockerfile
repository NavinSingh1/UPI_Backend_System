FROM node:20-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer independently
# of source changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Run as the non-root user that the node image already provides
USER node

EXPOSE 5000

# The health endpoint is defined in src/app.js
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
