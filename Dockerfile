FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --legacy-peer-deps --omit=dev
COPY . .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm","start"]
