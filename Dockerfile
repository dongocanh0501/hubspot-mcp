# Multi-stage build for ultra-lightweight production image (<100MB RAM)
FROM node:20-alpine AS builder

WORKDIR /build

# Install pnpm v9 to prevent pnpm 10 build script rejection
RUN npm install -g pnpm@9

# Copy package manifests
COPY package.json pnpm-lock.yaml tsconfig.json ./

# Fetch and install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src/ ./src/

# Build TypeScript to dist/
RUN pnpm build

# Prune dev dependencies
RUN pnpm prune --prod

# --- Runtime Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
# Restrict V8 heap to keep container within Railway Free Tier (<128MB)
ENV NODE_OPTIONS="--max-old-space-size=96"
ENV PORT=8080

# Copy only production dependencies and built files
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json

EXPOSE 8080

# Run with non-root user
USER node

# Directly execute node without wrapping via npm/pnpm to save 30MB RAM
CMD ["node", "dist/index.js"]
