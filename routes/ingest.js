/**
 * INGEST ROUTES
 * Handles embedding generation and storage for all Ironclad data types.
 *
 * POST /ingest/invoice       — Embed + store a single invoice
 * POST /ingest/batch         — Embed + store full localStorage export
 * POST /ingest/agreement     — Embed + store a vendor agreement
 * POST /ingest/document      — Embed + store an uploaded document
 * POST /ingest/reembed       — Re-embed all records missing embeddings
 */

const express = require('express');
const router = express.Router();

const {
  embed,
  embedBatch,
  buildInvoiceEmbedText,
  buildAgreementEmbedText,
  buildEquipmentEmbedText
} = require('../lib/openai');

const {
  upsertInvoice,
  upsertLineItems,
  updateInvoiceEmbedding,
  upsertAgreement,
  updateAgreementEmbedding,
  upsertEquipment,
  insertDocument,
  insertTransaction,
  getInvoicesWithoutEmbedding
} = require('../lib/supabase');


// ─── POST /ingest/invoice ─────────────────────────────────────────────────────
// Embed and store a single invoice (called when user saves a new invoice in-app)
router.post('/invoice', async (req, res) => {
  try {
    const invoice = req.body;

    if (!invoice.id || !invoice.date) {
      return res.status(400).json({ error: 'Invoice must have id and date' });
    }

    // Pull out line items before upserting
    const lineItems = invoice._line_items || [];
    delete invoice._line_items;

    // 1. Generate embedding
    const embedText = buildInvoiceEmbedText(invoice);
    const embedding = await embed(embedText);

    // 2. Store invoice + embedding
    const { id } = await upsertInvoice({ ...invoice, embedding });
    await upsertLineItems(id, lineItems);

    res.json({
      success:   true,
      invoiceId: id,
      embedded:  true
    });
  } catch (err) {
    console.error('[/ingest/invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /ingest/batch ───────────────────────────────────────────────────────
// Batch ingest from localStorage export — runs after migration
router.post('/batch', async (req, res) => {
  try {
    const { invoices = [], transactions = [] } = req.body;

    if (!Array.isArray(invoices)) {
      return res.status(400).json({ error: 'invoices must be an array' });
    }

    console.log(`[/ingest/batch] Processing ${invoices.length} invoices, ${transactions.length} transactions`);
    const results = { invoices: { success: 0, failed: 0, errors: [] }, transactions: { success: 0, failed: 0 } };

    // ── Embed all invoices in batch ──────────────────────────────────────────
    const embedTexts = invoices.map(buildInvoiceEmbedText);
    const embeddings = await embedBatch(embedTexts);

    // ── Upsert invoices with embeddings ─────────────────────────────────────
    for (let i = 0; i < invoices.length; i++) {
      const invoice = invoices[i];
      const lineItems = invoice._line_items || [];
      delete invoice._line_items;

      try {
        const { id } = await upsertInvoice({ ...invoice, embedding: embeddings[i] });
        await upsertLineItems(id, lineItems);
        results.invoices.success++;
      } catch (err) {
        results.invoices.failed++;
        results.invoices.errors.push({ id: invoice.id, error: err.message });
        console.warn(`[/ingest/batch] Invoice ${invoice.id} failed:`, err.message);
      }
    }

    // ── Upsert transactions ──────────────────────────────────────────────────
    for (const transaction of transactions) {
      try {
        await insertTransaction(transaction);
        results.transactions.success++;
      } catch (err) {
        results.transactions.failed++;
        console.warn('[/ingest/batch] Transaction failed:', err.message);
      }
    }

    console.log(`[/ingest/batch] Done. Invoices: ${results.invoices.success} ok, ${results.invoices.failed} failed`);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[/ingest/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /ingest/agreement ───────────────────────────────────────────────────
// Embed and store a vendor agreement
router.post('/agreement', async (req, res) => {
  try {
    const agreement = req.body;

    if (!agreement.id || !agreement.vendor) {
      return res.status(400).json({ error: 'Agreement must have id and vendor' });
    }

    const embedText = buildAgreementEmbedText(agreement);
    const embedding = await embed(embedText);

    await upsertAgreement({ ...agreement, embedding });

    res.json({ success: true, agreementId: agreement.id, embedded: true });
  } catch (err) {
    console.error('[/ingest/agreement]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /ingest/document ────────────────────────────────────────────────────
// Embed and store an arbitrary document (audit report, manual, notes, etc.)
router.post('/document', async (req, res) => {
  try {
    const { title, type, content, source_url, metadata } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Document must have title and content' });
    }

    const embedding = await embed(`${title}\n\n${content}`);

    const { id } = await insertDocument({
      title, type, content, source_url, metadata, embedding
    });

    res.json({ success: true, documentId: id, embedded: true });
  } catch (err) {
    console.error('[/ingest/document]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /ingest/equipment ───────────────────────────────────────────────────
// Embed and store an equipment unit record
router.post('/equipment', async (req, res) => {
  try {
    const unit = req.body;

    if (!unit.unit_id) {
      return res.status(400).json({ error: 'Equipment must have unit_id' });
    }

    const embedText = buildEquipmentEmbedText(unit);
    const embedding = await embed(embedText);

    await upsertEquipment({ ...unit, embedding });

    res.json({ success: true, unitId: unit.unit_id, embedded: true });
  } catch (err) {
    console.error('[/ingest/equipment]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /ingest/reembed ─────────────────────────────────────────────────────
// Re-embed all invoices that are missing embeddings (repair job)
router.post('/reembed', async (req, res) => {
  try {
    const { limit = 50 } = req.body;

    const invoices = await getInvoicesWithoutEmbedding(limit);
    console.log(`[/ingest/reembed] Found ${invoices.length} invoices without embeddings`);

    if (invoices.length === 0) {
      return res.json({ success: true, message: 'All invoices already have embeddings', count: 0 });
    }

    const embedTexts = invoices.map(buildInvoiceEmbedText);
    const embeddings = await embedBatch(embedTexts);

    let success = 0;
    for (let i = 0; i < invoices.length; i++) {
      try {
        await updateInvoiceEmbedding(invoices[i].id, embeddings[i]);
        success++;
      } catch (err) {
        console.warn(`[/ingest/reembed] Failed on ${invoices[i].id}:`, err.message);
      }
    }

    res.json({ success: true, embedded: success, total: invoices.length });
  } catch (err) {
    console.error('[/ingest/reembed]', err.message);
    res.status(500).json({ error: err.message });
  }
});


module.exports = { ingestRouter: router };
