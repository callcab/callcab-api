#!/bin/bash

# Create directory structure
mkdir -p src/handlers
mkdir -p src/lib
mkdir -p src/data/locations
mkdir -p tests

# Create empty files
touch .gitignore
touch package.json
touch wrangler.toml
touch README.md
touch src/index.js
touch src/handlers/validate-address.js
touch src/handlers/account-eligibility.js
touch src/handlers/dispatch-eta.js
touch src/handlers/icabbi-lookup.js
touch src/handlers/icabbi-booking.js
touch src/lib/location-db.js
touch src/lib/google-api.js
touch src/lib/utils.js
touch src/data/locations/combine.js
touch tests/test-suite.sh
touch tests/test-payload.json

echo "✅ File structure created!"
echo "Now paste content into each file."