FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
