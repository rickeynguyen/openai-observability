FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
# Install all dependencies including dev (Playwright) to enable browser runner
RUN npm ci || npm install
COPY . .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm","start"]
