# Lightweight Node.js 24 on Alpine Linux for Firebase Admin SDK and current build tools
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Install dependencies needed for sqlite3 compilation if needed
RUN apk add --no-cache python3 make g++

# Copy package manifests first for optimal layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Ensure runtime directories exist
RUN mkdir -p data/backups logs dist-apk

# Copy application source code
COPY src/ ./src/
COPY public/ ./public/
COPY dist-apk* ./dist-apk/

# Expose server port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "src/server.js"]
