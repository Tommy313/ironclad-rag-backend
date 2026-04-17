/**
 * lib/openai.js
 * OpenAI embedding + GPT helpers for the Ironclad RAG backend.
 */

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_MODEL = 'text-embedding-3-small'; // 1536 dims, cheap & fast
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';


// ─── Single embedding ─────────────────────────────────────────────────────────
/**
 * @param {string} text
 * @returns {Promise<number[]>} 1-536 float vector
 */
async function embed(text) {
  if (!text || !text.trim()) throw new Error('embed(): text is empty');
  const resp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text.trim()
  });
  return resp.data[0].embedding;
}


// ─── Batch embeddings ────────────────────────────────────────────────────────
/**
 * Embed multiple texts efficiently (up to 100 per OpenAI token batch).
 * @param {string[]} texts
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function embedBatch(texts) {
  const CHUNK_SIZE = 100;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const resp = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: chunk.map(t => t.trim())
    });
    results.push(...resp.data.map(d => d.embedding));
  }
  return results;
}


// ─── Text builders ───────────────────────────────────────────────────────────
/**
 * Builds a rich text string for an invoice that captures all searchable dimensions.
 */
function buildInvoiceEmbedText(invoice) {
  const parts = [
    `Invoice from ${invoice.vendor_name || 'Unknown Vendor'}`,
    invoice.unit_number      ? `Unit: ${invoice.unit_number}`             : null,
    invoice.category         ? `Category: ${invoice.category}`            : null,
    invoice.description      ? `Description: ${invoice.description}`     : null,
    invoice.total_amount     ? `Total: $${invoice.total_amount}`          : null,
    invoice.invoice_date     ? `Date: ${invoice.invoice_date}`            : null,
    invoice.invoice_number   ? `Invoice #: ${invoice.invoice_number}`     : null,
    invoice.is_flagged       ? `Flagged for review: ${invoice.flag_reason || 'Yes'}` : null,
    invoice.location         ? `Location: ${invoice.location}`            : null,
    invoice.notes            ? `Notes: ${invoice.notes}`                   : null,
  ];
  return parts.filter(Boolean).join('. ');
}

/**
 * Builds a rich text string for a vendor agreement/contract.
 */
function buildAgreementEmbedText(agreement) {
  const parts = [
    `Agreement with ${agreement.vendor_name || 'Unknown Vendor'}`,
    agreement.agreement_type  ? `Type: ${agreement.agreement_type}`   : null,
    agreement.description     ? `Description: ${agreement.description}` : null,
    agreement.status          ? `Status: ${agreement.status}`         : null,
    agreement.value           ? `Value: $${agreement.value}`           : null,
    agreement.start_date      ? `Start: ${agreement.start_date}`      : null,
    agreement.end_date        ? `End: ${agreement.end_date}`           : null,
    agreement.terms           ? `Terms: ${agreement.terms}`            : null,
  ];
  return parts.filter(Boolean).join('. ');
}

/**
 * Builds a rich-text string for an equipment unit.
 */
function buildEquipmentEmbedText(equipment) {
  const parts = [
    `Equipment unit ${equipment.unit_number || ''}`,
    equipment.make           ? `Make: ${equipment.make}`                 : null,
    equipment.model          ? `Model: ${equipment.model}`               : null,
    equipment.year           ? `Year: ${equipment.year}`                  : null,
    equipment.equipment_type ? `Type: ${equipment.equipment_type}`       : null,
    equipment.status         ? `Status: ${equipment.status}`             : null,
    equipment.mileage        ? `Mileage: ${equipment.mileage} miles`      : null,
    equipment.location       ? `Location: ${equipment.location}`         : null,
    equipment.notes          ? `Notes: ${equipment.notes}`                : null,
  ];
  return parts.filter(Boolean).join('. ');
}


// ─── RAG query (GPT) ──────────────────────────────────────────────────────
/**
 * Run a RAG query against the retrieved context.
 * @param {string} userQuery
 * @param {Array} retrievedContext  - array of { content, similarity, source_type }
 * @returns {Promise<{answer: string, usage: object}>}
 */
async function runRAGQuery(userQuery, retrievedContext) {
  const contextBlock = retrievedContext
    .map((c, i) => `[${i + 1}] ${c.source_type}: ${c.content}`)
    .join('\n\n');

  const systemPrompt = `You are Ironclad Fleet Intelligence, an AI assistant specialized in fleet management. \
You have access to invoices, contracts, equipment records, work orders, and financial data. \
Answer questions concisely and accurately based on the retrieved context only. \
If you don't know or data is not in the context, say so clearly. \
Always reference specific invoice numbers, vendor names, or dates when available.`;

  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${userQuery}` }
    ],
    temperature: 0.1, // Low temp for factual reporting
    max_tokens: 500
  });

  return {
    answer: resp.choices[0].message.content,
    usage: resp.usage
  };
}


module.exports = { embed, embedBatch, buildInvoiceEmbedText, buildAgreementEmbedText, buildEquipmentEmbedText, runRAGQuery };
