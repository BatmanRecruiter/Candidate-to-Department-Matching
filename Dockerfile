FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=7860
ENV NODE_ENV=production

EXPOSE 7860

CMD ["node", "dist/index.cjs"]
