# Neri Cash live demo: one Node service serving the API (api/) and the app (app/) on the same origin.
# Built and run by Fly.io (fly.toml). Secrets (Supabase, Anthropic) come from `fly secrets`, never the image.
FROM node:22-slim

WORKDIR /srv
ENV NODE_ENV=production

# tsx runs the TypeScript entry point, so dev dependencies are installed too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force

COPY . .

# The server serves app/config.js live (same-origin API + public Supabase values from env); see api/app.ts.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["npx", "tsx", "api/server.ts"]
