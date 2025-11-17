#!/bin/bash

API_BASE="https://api.callcab.ai"

echo "🧪 High Mountain Taxi API Test Suite"
echo "===================================="

# Test 1: Health
echo "Test 1: Health Check..."
curl -s "$API_BASE/health" | grep -q '"ok":true' && echo "✅ PASS" || echo "❌ FAIL"

# Test 2: Validate Address
echo "Test 2: Validate Address..."
curl -s -X POST "$API_BASE/validate-address" \
  -H "Content-Type: application/json" \
  -d '{"query": "Hotel Jerome"}' | grep -q '"best_match_name":"Hotel Jerome"' && echo "✅ PASS" || echo "❌ FAIL"

echo "===================================="
echo "Tests complete!"