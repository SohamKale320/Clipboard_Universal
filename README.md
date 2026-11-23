# Clipboard clone

Share text with a 6-digit code. Next.js (App Router) + Upstash Redis.

Features: auto-expiry (5 min – 1 year), optional passcode (scrypt-hashed), burn after reading (atomic `GETDEL`),
QR code + direct link `/123456`, per-IP rate limiting, wrong-passcode lockout.

## Deploy on Vercel
1. Push this folder to a GitHub repo.
2. vercel.com → Add New → Project → import the repo.
3. In the project: Storage → Marketplace → Upstash → Redis → create + connect. Env vars are added for you.
4. Redeploy (Deployments → ⋯ → Redeploy) so the env vars are picked up.

## Run locally
```bash
npm install
vercel link && vercel env pull .env.local   # or copy .env.example and fill it in
npm run dev
```
