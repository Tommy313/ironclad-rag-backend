/**
 * QUERY ROUTES — RAG-powered AI chat
 *
 * POST /query/chat   — Full RAG query: embed question → retrieve context → GPT answer
 */

const express = require('express');
const router = express.Router();

const { embed, runRAGQuery }  = require('../lib/openai');
const { searchAll }           = require('../lib/supabase');

const rateLimit = require('express-rate-limit');

// Stricter rate limit on AI query endpoint (costs money per call)
const queryLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 20,               // 20 AI queries per minute max
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI queries. Wait a moment before trying again.' }
});


// ─── POST /query/chat ─────────────────────────────────────────────────────────
// Full RAG pipeline: embed query → vector search → LLM answer
router.post('/chat', queryLimiter, async (req, res) => {
  try {
    const {
      question,
      threshold = 0.60,   // similarity threshold for retrieval
      topK      = 15,     // max context chunks to retrieve
      tables    = null    // optional: filter to specific tables ['invoices', 'agreements']
    } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question is required and must be a non-empty string' });
    }

    const query = question.trim();
    console.log(`[/query/chat] Query: "${query.slice(0, 80)}..."`);

    // 1. Embed the user's question
    const queryEmbedding = await embed(query);

    // 2. Retrieve relevant context from Supabase (vector similarity search)
    let context = await searchAll(queryEmbedding, {
      threshold,
      count: topK,
    });

    // Optional: filter to specific source tables
    if (tables && Array.isArray(tables) && tables.length > 0) {
      context = context.filter(c => tables.includes(c.source_table));
    }

    console.log(`[/query/chat] Retrieved ${context.length} context chunks`);

    // 3. Run the RAG completion (GPT reads context + answers question)
    const { answer, model, usage, finishReason } = await runRAGQuery(query, context);

    // 4. Return answer + sources for citation in the UI
    res.json({
      success: true,
      question: query,
      answer,
      sources: context.map(c => ({
        table:      c.source_table,
        id:         c.source_id,
        similarity: c.similarity,
        metadata:   c.metadata
      })),
      meta: {
        model,
        usage,
        finishReason,
        contextChunks: context.length
      }
    });

  } catch (err) {
    console.error('[/query/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── GET /query/status ────────────────────────────────────────────────────────
// Quick check of query service availability
router.get('/status', (req, res) => {
  res.json({
    service: 'ironclad-rag-query',
    ready:   true,
    model:   process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    embedding: 'text-embedding-3-small'
  });
});


module.exports = { queryRouter: router };
