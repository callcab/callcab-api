# High Mountain Taxi API

Cloudflare Workers API for High Mountain Taxi AI Dispatcher (Claire).

## Quick Start
```bash
# Install dependencies
npm install

# Build location database
npm run build

# Run locally
npm run dev

# Deploy to dev
npm run deploy:dev

# Deploy to production
npm run deploy:prod
```

## API Endpoints

- `POST /validate-address` - Validate and enrich addresses
- `POST /account-eligibility` - Check HOA/subsidized ride eligibility
- `POST /dispatch-eta` - Calculate driver arrival time
- `POST /icabbi-lookup` - Look up customer in iCabbi
- `POST /icabbi-booking` - Create/modify/cancel bookings

## Environment Setup

Set secrets:
```bash
wrangler secret put GOOGLE_MAPS_API_KEY
wrangler secret put ICABBI_APP_KEY
wrangler secret put ICABBI_SECRET
wrangler secret put ICABBI_BASE_URL
```

## Documentation

See `/docs` for full API documentation and deployment guide.