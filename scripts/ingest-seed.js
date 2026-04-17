/**
 * One-time seed ingest — posts seed-payload.json to the RAG backend /ingest/batch
 * Run: node scripts/ingest-seed.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const RAG_URL = process.env.RAG_URL || 'https://rag-backend-production-1500.up.railway.app';
const payload = fs.readFileSync(path.join(__dirname, 'seed-payload.json'), 'utf8');

console.log(`POSTing to ${RAG_URL}/ingest/batch ...`);
console.log(`Payload size: ${Buffer.byteLength(payload)} bytes`);

const url = new URL(`${RAG_URL}/ingest/batch`);
const options = {
  hostname: url.hostname,
  port: 443,
  path: '/ingest/batch',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const parsed = JSON.parse(data);
      console.log('Result:', JSON.stringify(parsed, null, 2));
      if (!parsed.success) process.exit(1);
    } catch {
      console.log('Raw response:', data.slice(0, 500));
    }
  });
});

req.on('error', (e) => { console.error('Request error:', e.message); process.exit(1); });
req.setTimeout(120000, () => { console.error('Timeout'); req.destroy(); process.exit(1); });
req.write(payload);
req.end();
