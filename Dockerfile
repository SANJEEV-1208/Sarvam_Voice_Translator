# In: sarvam-live-translator/Dockerfile

FROM node:20-slim

WORKDIR /app

# Copy from project folder
COPY project/package*.json ./

RUN npm ci --only=production

# Copy the rest from project folder
COPY project/ .

EXPOSE 3000

CMD ["node", "server.js"]