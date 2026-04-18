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
 * Every field that a user might ask about should be represented here.
 */
function buildInvoiceEmbedText(invoice) {
  const vendor = invoice.vendor || invoice.vendor_name || 'Unknown Vendor';
  const unitId = invoice.unit_id || invoice.unit_number || null;
  const total  = invoice.parts_total != null && invoice.labor_total != null
    ? (parseFloat(invoice.parts_total) + parseFloat(invoice.labor_total) + parseFloat(invoice.misc_total || 0)).toFixed(2)
    : invoice.total_amount || null;
  const laborHrs = invoice.expected_hours_low && invoice.expected_hours_high
    ? `Expected hours: ${invoice.expected_hours_low}–${invoice.expected_hours_high}`
    : null;
  const flagInfo = invoice.flags && invoice.flags.length
    ? `Flags: ${invoice.flags.join(', ')}. ${invoice.flag_notes || ''}`
    : null;
  const techInfo = invoice.techs && invoice.techs.length
    ? `Technicians: ${invoice.techs.join(', ')}`
    : null;

  const parts = [
    `Invoice ${invoice.id || invoice.invoice_number || ''} from ${vendor}`,
    unitId                    ? `Unit ID: ${unitId}`                               : null,
    invoice.serial_number     ? `Serial number: ${invoice.serial_number}`          : null,
    invoice.equipment         ? `Equipment: ${invoice.equipment}`                  : null,
    invoice.category          ? `Category: ${invoice.category}`                    : null,
    invoice.description       ? `Description: ${invoice.description}`              : null,
    total                     ? `Total: $${total}`                                  : null,
    invoice.labor_total       ? `Labor: $${invoice.labor_total}`                   : null,
    invoice.parts_total       ? `Parts: $${invoice.parts_total}`                   : null,
    invoice.misc_total        ? `Misc: $${invoice.misc_total}`                     : null,
    invoice.visits            ? `Visits: ${invoice.visits}`                        : null,
    laborHrs,
    techInfo,
    invoice.work_dates        ? `Work dates: ${invoice.work_dates}`                : null,
    invoice.date              ? `Date: ${invoice.date}`                             : null,
    invoice.meter_hours       ? `Meter hours: ${invoice.meter_hours}`              : null,
    invoice.region            ? `Region: ${invoice.region}`                        : null,
    invoice.site              ? `Site: ${invoice.site}`                            : null,
    invoice.agreement_status  ? `Agreement: ${invoice.agreement_status}`           : null,
    invoice.vendor_type       ? `Vendor type: ${invoice.vendor_type}`              : null,
    flagInfo,
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


// ─── Format context chunk for GPT ────────────────────────────────────────────
/**
 * Converts a retrieved context chunk into a richly formatted string for GPT.
 * Includes both the semantic content text AND all structured metadata fields
 * so the model has full access to IDs, serials, flags, amounts, etc.
 */
function formatContextChunk(chunk, index) {
  const lines = [`[${index + 1}] ${(chunk.source_type || chunk.source_table || 'record').toUpperCase()}`];

  // Always include the embedded content text
  if (chunk.content) {
    lines.push(`  Content: ${chunk.content}`);
  }

  // Supplement with structured metadata so nothing is left out
  const m = chunk.metadata || {};

  if (chunk.source_table === 'invoices' || chunk.source_type === 'invoice') {
    const structured = [];
    if (chunk.source_id || m.id)          structured.push(`Invoice ID: ${chunk.source_id || m.id}`);
    if (m.unit_id)                         structured.push(`Unit ID: ${m.unit_id}`);
    if (m.serial_number)                   structured.push(`Serial Number: ${m.serial_number}`);
    if (m.vendor)                          structured.push(`Vendor: ${m.vendor}`);
    if (m.equipment)                       structured.push(`Equipment: ${m.equipment}`);
    if (m.category)                        structured.push(`Category: ${m.category}`);
    if (m.date)                            structured.push(`Date: ${m.date}`);
    if (m.work_dates)                      structured.push(`Work Dates: ${m.work_dates}`);
    if (m.site)                            structured.push(`Site: ${m.site}`);
    if (m.region)                          structured.push(`Region: ${m.region}`);
    if (m.labor_total != null)             structured.push(`Labor: $${m.labor_total}`);
    if (m.parts_total != null)             structured.push(`Parts: $${m.parts_total}`);
    if (m.misc_total != null)              structured.push(`Misc: $${m.misc_total}`);
    const total = (parseFloat(m.labor_total||0) + parseFloat(m.parts_total||0) + parseFloat(m.misc_total||0));
    if (total > 0)                         structured.push(`Total: $${total.toFixed(2)}`);
    if (m.visits)                          structured.push(`Visits: ${m.visits}`);
    if (m.expected_hours_low != null)      structured.push(`Expected Hours: ${m.expected_hours_low}–${m.expected_hours_high}`);
    if (m.meter_hours)                     structured.push(`Meter Hours: ${m.meter_hours}`);
    if (m.agreement_status)               structured.push(`Agreement: ${m.agreement_status}`);
    if (m.techs && m.techs.length)        structured.push(`Technicians: ${m.techs.join(', ')}`);
    if (m.flags && m.flags.length)        structured.push(`Flags: ${m.flags.join(', ')}`);
    if (m.flag_notes)                      structured.push(`Flag Notes: ${m.flag_notes}`);
    if (m.description)                     structured.push(`Description: ${m.description}`);
    if (structured.length > 0) {
      lines.push(`  Fields: ${structured.join(' | ')}`);
    }
  } else if (Object.keys(m).length > 0) {
    // For agreements, documents, etc. — just dump the key fields
    const extras = Object.entries(m)
      .filter(([k, v]) => v != null && v !== '' && !Array.isArray(v))
      .map(([k, v]) => `${k}: ${v}`)
      .slice(0, 12);
    if (extras.length > 0) lines.push(`  Fields: ${extras.join(' | ')}`);
  }

  lines.push(`  Similarity: ${(chunk.similarity || 0).toFixed(3)}`);
  return lines.join('\n');
}


// ─── RAG query (GPT) ──────────────────────────────────────────────────────
/**
 * Run a RAG query against the retrieved context.
 * @param {string} userQuery
 * @param {Array} retrievedContext  - array of { content, similarity, source_type, source_table, source_id, metadata }
 * @returns {Promise<{answer: string, model: string, usage: object, finishReason: string}>}
 */
async function runRAGQuery(userQuery, retrievedContext) {
  const contextBlock = retrievedContext
    .map((c, i) => formatContextChunk(c, i))
    .join('\n\n');

  const systemPrompt = `You are Ironclad Audit Intelligence, an AI assistant for equipment fleet audits.

You have access to invoice records, vendor contracts, equipment data, and financial figures retrieved from a fleet audit database.

CRITICAL INSTRUCTIONS:
- Each context block contains BOTH a "Content" summary AND a "Fields" section with structured data (IDs, serial numbers, dollar amounts, flags, etc.).
- ALWAYS use the Fields section to answer questions about IDs, serial numbers, unit numbers, technicians, dates, and amounts — this is the authoritative structured data.
- When asked for machine IDs, serial numbers, or unit IDs, look in the "Fields" section under "Unit ID:" and "Serial Number:".
- Quote specific invoice IDs, dollar amounts, vendor names, and dates in every answer.
- For calculations (totals, averages, highest/lowest), work through the numbers explicitly.
- If a field is present in the context, report it — do not say "data is not available" if it appears in any Fields section.
- If genuinely absent from all context chunks, say so clearly.`;

  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Retrieved context (${retrievedContext.length} records):\n\n${contextBlock}\n\n---\nQuestion: ${userQuery}` }
    ],
    temperature: 0.1, // Low temp for factual reporting
    max_tokens: 700   // Increased to allow fuller answers
  });

  return {
    answer:       resp.choices[0].message.content,
    model:        resp.model,
    usage:        resp.usage,
    finishReason: resp.choices[0].finish_reason
  };
}


module.exports = { embed, embedBatch, buildInvoiceEmbedText, buildAgreementEmbedText, buildEquipmentEmbedText, runRAGQuery };
