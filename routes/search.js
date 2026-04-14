/**
 * SEARCH ROUTES — Semantic similarity search (no LLM, just vector retrieval)
 * Faster and cheaper than /query/chat — use for live search-as-you-type
 *
 * POST /search        — Search across all tables
 * POST /search/invoices   — Search invoices only
 * POST /search/documents  — Search documents only
 */

const express = require('express');
const router = express.Router();

const { embed }                           = require('../lib/openai');
const { searchAll, searchInvoices, searchDocuments } = require('../lib/supabase');


// ─── POST /search ─────────────────────────────────────────────────────────────
// Universal semantic search across all Ironclad data
router.post('/', async (req, res) => {
  try {
    const {
      query,
      threshold = 0.60,
      limit     = 15
    } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    const queryEmbedding = await embed(query.trim());
    const results = await searchAll(queryEmbedding, { threshold, count: limit });

    res.json({
      success: true,
      query:   query.trim(),
      results,
      count:   results.length
    });
  } catch (err) {
    console.error('[/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /search/invoices ────────────────────────────────────────────────────
router.post('/invoices', async (req, res) => {
  try {
    const { query, threshold = 0.65, limit = 10 } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    const queryEmbedding = await embed(query.trim());
    const results = await searchInvoices(queryEmbedding, { threshold, count: limit });

    res.json({ success: true, query: query.trim(), results, count: results.length });
  } catch (err) {
    console.error('[/search/invoices]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /search/documents ───────────────────────────────────────────────────
router.post('/documents', async (req, res) => {
  try {
    const { query, threshold = 0.60, limit = 8 } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    const queryEmbedding = await embed(query.trim());
    const results = await searchDocuments(queryEmbedding, { threshold, count: limit });

    res.json({ success: true, query: query.trim(), results, count: results.length });
  } catch (err) {
    console.error('[/search/documents]', err.message);
    res.status(500).json({ error: err.message });
  }
});


module.exports = { searchRouter: router };
