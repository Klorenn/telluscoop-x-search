FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
