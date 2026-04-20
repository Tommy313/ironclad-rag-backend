/**
 * Ironclad RAG — Full Supabase sync
 *
 * Fetches ALL invoices from Supabase and posts them to /ingest/batch
 * so the vector store stays in sync with the live database.
 *
 * Required env vars (set as GitHub secrets or local .env):
 *   SUPABASE_URL          — e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY     — public anon key (safe to use here)
 *   RAG_URL               — e.g. https://rag-backend-production-1500.up.railway.app
 *
 * Run:  node scripts/ingest-seed.js
 */

const https = require('https');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const RAG_URL       = process.env.RAG_URL || 'https://rag-backend-production-1500.up.railway.app';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  console.error('Set them as environment variables or GitHub secrets.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(urlStr);
    const req  = https.request({
      hostname: url.hostname,
      port:     443,
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Timeout after 5min')); });
    req.write(body);
    req.end();
  });
}

// ── Fetch all invoices from Supabase (paginated) ──────────────────────────────

async function fetchAllInvoices() {
  const invoices = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/invoices?select=*&order=date.desc&limit=${pageSize}&offset=${offset}`;
    const { status, body } = await httpsGet(url, {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    });

    if (status !== 200) {
      throw new Error(`Supabase returned ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    }

    if (!Array.isArray(body) || body.length === 0) break;
    invoices.push(...body);
    if (body.length < pageSize) break;
    offset += pageSize;
  }

  return invoices;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching invoices from Supabase...');
  console.log(`  ${SUPABASE_URL}`);

  let invoices;
  try {
    invoices = await fetchAllInvoices();
  } catch (err) {
    console.error('Supabase fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`Fetched ${invoices.length} invoices`);

  if (invoices.length === 0) {
    console.warn('No invoices found — nothing to ingest. Exiting.');
    process.exit(0);
  }

  // Map DB rows to the format /ingest/batch expects
  const payload = {
    invoices: invoices.map(row => ({
      id:                  row.id,
      date:                row.date,
      work_dates:          row.work_dates          || null,
      equipment:           row.equipment           || null,
      serial_number:       row.serial_number       || null,
      unit_id:             row.unit_id             || null,
      meter_hours:         row.meter_hours         || null,
      site:                row.site                || null,
      region:              row.region              || null,
      category:            row.category            || null,
      description:         row.description         || null,
      vendor:              row.vendor              || null,
      agreement_status:    row.agreement_status    || 'none',
      techs:               row.techs               || [],
      visits:              row.visits              || 1,
      parts_total:         parseFloat(row.parts_total)  || 0,
      labor_total:         parseFloat(row.labor_total)  || 0,
      misc_total:          parseFloat(row.misc_total)   || 0,
      flags:               row.flags               || [],
      flag_notes:          row.flag_notes          || null,
      expected_hours_low:  row.expected_hours_low  || null,
      expected_hours_high: row.expected_hours_high || null,
      vendor_type:         row.vendor_type         || null,
      client:              row.client              || 'Ferrous',
      _line_items:         [],
    })),
    transactions: [],
  };

  const payloadSize = Buffer.byteLength(JSON.stringify(payload));
  console.log(`\nPOSTing to ${RAG_URL}/ingest/batch`);
  console.log(`Payload: ${invoices.length} invoices, ${(payloadSize / 1024).toFixed(1)} KB`);

  let result;
  try {
    result = await httpsPost(`${RAG_URL}/ingest/batch`, payload);
  } catch (err) {
    console.error('RAG backend request failed:', err.message);
    process.exit(1);
  }

  console.log(`\nHTTP ${result.status}`);
  if (result.body?.results) {
    const r = result.body.results;
    console.log(`Invoices: ${r.invoices?.success ?? 0} embedded, ${r.invoices?.failed ?? 0} failed`);
    if (r.invoices?.errors?.length) {
      console.warn('Errors:', r.invoices.errors.slice(0, 5));
    }
  } else {
    console.log('Response:', JSON.stringify(result.body, null, 2).slice(0, 500));
  }

  if (!result.body?.success) {
    console.error('Ingest reported failure');
    process.exit(1);
  }

  console.log('\nDone — vector store is up to date.');
}

main().catch(err => { console.error(err); process.exit(1); });
