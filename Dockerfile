FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
COPY . .
RUN npm run build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only install production dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev

# Generate Prisma client in production image
RUN npx prisma generate

# Copy compiled output
COPY --from=builder /app/dist ./dist

# WhatsApp session files are persisted via Railway volume at /app/auth_info_baileys
# (mount the volume in Railway settings → Volume → /app/auth_info_baileys)

EXPOSE 3000

# Run DB migration then start the app
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
