/**
 * lib/supabase.js
 * Supabase service-role client for the Ironclad RAG backend.
 * Uses the service role key to bypass RLS and perform all writes.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


// ─── Invoice operations ─────────────────────────────────────────────────────
async function upsertInvoice(invoice) {
  const { data, error } = await supabase
    .from('invoices')
    .upsert(invoice, { onConflict: 'external_id', ignoreDuplicates: false })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function upsertLineItems(invoiceId, lineItems) {
  if (!lineItems || lineItems.length === 0) return;
  const items = lineItems.map(item => ({ ...item, invoice_id: invoiceId }));
  const { error } = await supabase.from('invoice_line_items').upsert(items);
  if (error) throw error;
}

async function updateInvoiceEmbedding(id, embedding) {
  const { error } = await supabase
    .from('invoices')
    .update({ embedding: `[${embedding.join(',')}]` })
    .eq('id', id);
  if (error) throw error;
}


// ─── Agreement operations ─────────────────────────────────────────────────
async function upsertAgreement(agreement) {
  const { data, error } = await supabase
    .from('agreements')
    .upsert(agreement, { onConflict: 'external_id', ignoreDuplicates: false })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function updateAgreementEmbedding(id, embedding) {
  const { error } = await supabase
    .from('agreements')
    .update({ embedding: `[${embedding.join(',')}]` })
    .eq('id', id);
  if (error) throw error;
}


// ─── Equipment operations ────────────────────────────────────────────────
async function upsertEquipment(equipment) {
  const { data, error } = await supabase
    .from('equipment')
    .upsert(equipment, { onConflict: 'unit_number', ignoreDuplicates: false })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function updateEquipmentEmbedding(id, embedding) {
  const { error } = await supabase
    .from('equipment')
    .update({ embedding: `[${embedding.join(',')}]` })
    .eq('id', id);
  if (error) throw error;
}


// ─── Document operations ───────────────────────────────────────────────────
async function insertDocument(doc) {
  const { data, error } = await supabase
    .from('documents')
    .insert(doc)
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function insertTransaction(txn) {
  const { data, error } = await supabase
    .from('transactions')
    .upsert(txn, { onConflict: 'external_id', ignoreDuplicates: false })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}


// ─── Semantic search ────────────────────────────────────────────────────────
async function searchAll(embedding, threshold = 0.3, count = 8) {
  const { data, error } = await supabase.rpc('match_all', {
    query_embedding: `[${embedding.join(',')}]`,
    match_threshold: threshold,
    match_count: count
  });
  if (error) throw error;
  return data || [];
}

async function searchInvoices(embedding, threshold = 0.3, count = 8) {
  const { data, error } = await supabase.rpc('match_invoices', {
    query_embedding: `[${embedding.join(',')}]`,
    match_threshold: threshold,
    match_count: count
  });
  if (error) throw error;
  return data || [];
}

async function searchDocuments(embedding, threshold = 0.3, count = 8) {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: `[${embedding.join(',')}]`,
    match_threshold: threshold,
    match_count: count
  });
  if (error) throw error;
  return data || [];
}

/** Get invoices missing embedding (for re-embed jobs) */
async function getInvoicesWithoutEmbedding(limit = 50) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .is('embedding', null)
    .limit(limit);
  if (error) throw error;
  return data || [];
}


module.exports = {
  upsertInvoice, upsertLineItems, updateInvoiceEmbedding,
  upsertAgreement, updateAgreementEmbedding,
  upsertEquipment, updateEquipmentEmbedding,
  insertDocument, insertTransaction,
  searchAll, searchInvoices, searchDocuments,
  getInvoicesWithoutEmbedding
};
