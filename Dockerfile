FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
# Install build tools for native addons (better-sqlite3) then deps
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 && rm -rf /var/lib/apt/lists/* \
	&& npm ci || npm install
COPY . .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm","start"]
