/**
 * IRONCLAD RAG BACKEND
 * Express server for embedding generation, ingestion, and AI-powered queries.
 * Deploy to Railway — connects to Supabase (pgvector) and OpenAI.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { ingestRouter } = require('./routes/ingest');
const { queryRouter } = require('./routes/query');
const { searchRouter } = require('./routes/search');

// ─── Validate required env vars at startup ────────────────────────────────────
const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use(helmet());

// CORS — only allow your Next.js app
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true); // dev: allow all
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization']
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Global rate limiting
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' }
}));


// ─── API key middleware for write/ingest routes ───────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!process.env.INGEST_API_KEY) return next(); // No key configured = skip (dev)
  if (key === process.env.INGEST_API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized. Valid x-api-key required.' });
}


// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/ingest', requireApiKey, ingestRouter);
app.use('/query', queryRouter);
app.use('/search', searchRouter);


// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'ironclad-rag',
    version:   '1.0.0',
    timestamp: new Date().toISOString()
  });
});


// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});


// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message, err.stack);
  res.status(500).json({
    error: 'Internal server error',
    detail: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});


// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Ironclad RAG] Server running on port ${PORT}`);
  console.log(`[Ironclad RAG] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Ironclad RAG] Supabase: ${process.env.SUPABASE_URL}`);
});

module.exports = app;
