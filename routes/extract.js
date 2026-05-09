/**
 * EXTRACT ROUTES — Smart invoice extraction
 *
 * Model selection (in priority order):
 *  1. Claude (Anthropic) — best at structured JSON, fewer hallucinations, reliable field extraction
 *     Used when ANTHROPIC_API_KEY is set. Text-layer PDFs only.
 *  2. GPT-4o Text — good fallback when Claude not configured. Text-layer PDFs.
 *  3. GPT-4o Vision — for scanned/image-only PDFs where no text layer exists.
 *
 * PDF Strategy:
 *  - pdf-parse extracts text first. If text is good (>200 chars), skip Vision entirely.
 *  - Digital dealer invoices (Alta, RECO, Michigan CAT) are almost always text-layer.
 *  - Cost: Claude text ~$0.001/invoice, GPT-4o text ~$0.002, Vision ~$0.02. Claude wins.
 */

const express   = require('express');
const router    = express.Router();
const OpenAI    = require('openai');
const pdfParse  = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── Which model to use for text extraction ────────────────────────────────────
// Claude preferred: follows JSON structure precisely, hallucinates less on null fields
// Falls back to GPT-4o text if no Anthropic key configured
const TEXT_MODEL  = anthropic ? 'claude' : 'gpt4o-text';

// ── Shared extraction prompt template ────────────────────────────────────────
function buildPrompt(vendorHint, isText = false) {
  const sourceNote = isText
    ? 'You are reading EXTRACTED TEXT from a heavy equipment dealer invoice (PDF text layer). Formatting artifacts like extra spaces or line breaks are normal — focus on the data values.'
    : 'You are reading a SCANNED IMAGE of a heavy equipment dealer invoice. Extract every visible field carefully.';

  return `${sourceNote}
Extract ALL invoice fields and return a single JSON object. This data feeds a financial audit engine — be precise.
${vendorHint}

Return ONLY valid JSON. Use null for any field not found. Do NOT use placeholder text:
{
  "invoiceNumber": null,
  "vendor": null,
  "date": null,
  "workDates": null,
  "equipment": null,
  "serialNumber": null,
  "unitId": null,
  "site": null,
  "meterHours": null,
  "laborTotal": null,
  "partsTotal": null,
  "miscTotal": null,
  "grandTotal": null,
  "techs": null,
  "visits": null,
  "description": null,
  "lineItems": [],
  "region": null,
  "agreementType": null
}

Rules:
- null for any field not clearly present.
- laborTotal = sum of labor lines only.
- partsTotal = sum of parts/materials only.
- miscTotal = travel, fuel surcharge, shop supplies, misc fees (NOT labor or parts).
- grandTotal = final invoice total as printed.
- lineItems: every line with { desc, qty, price } — capture all fee lines.
- description: full narrative combining all work notes, repair findings, and technician observations.
- techs: technician names from labor lines or signatures.
- date: invoice date (not work dates).
- Numbers: plain numbers, no $ or commas.`;
}

// ── Confidence wrapper ────────────────────────────────────────────────────────
const conf = (val, high = true, source = 'extracted') => ({
  value:      val ?? null,
  confidence: val != null && val !== '' ? (high ? 'HIGH' : 'MEDIUM') : null,
  source:     val != null ? source : 'Not found in invoice',
});

// ── Build standard fields response ───────────────────────────────────────────
function buildFields(extracted, source) {
  return {
    invoiceNumber: conf(extracted.invoiceNumber,    true,  source),
    vendor:        conf(extracted.vendor,           true,  source),
    date:          conf(extracted.date,             true,  source),
    workDates:     conf(extracted.workDates,        false, source),
    equipment:     conf(extracted.equipment,        true,  source),
    sn:            conf(extracted.serialNumber,     true,  source),
    unitId:        conf(extracted.unitId,           false, source),
    site:          conf(extracted.site,             false, source),
    meter:         conf(extracted.meterHours,       false, source),
    labor:         conf(extracted.laborTotal,       true,  source),
    parts:         conf(extracted.partsTotal,       true,  source),
    misc:          conf(extracted.miscTotal,        false, source),
    total:         conf(extracted.grandTotal,       true,  source),
    techs:         conf(Array.isArray(extracted.techs) && extracted.techs.length ? extracted.techs.join(', ') : null, false, source),
    visits:        conf(extracted.visits || 1,      false, source),
    description:   conf(extracted.description,      true,  source),
  };
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

async function callClaude(promptText, label) {
  // Claude: best structured JSON output, low hallucination rate on invoice fields
  const msg = await anthropic.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 2000,
    messages:   [{ role: 'user', content: promptText }],
  });
  const raw    = msg.content[0].text.trim();
  const jsonStr = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  console.log(`[extract/claude/${label}] ${raw.length} chars, input:${msg.usage?.input_tokens} output:${msg.usage?.output_tokens}`);
  return { jsonStr, usage: msg.usage, model: 'claude-opus-4-5' };
}

async function callGPT(content, label) {
  const resp = await openai.chat.completions.create({
    model:       'gpt-4o',
    messages:    [{ role: 'user', content }],
    max_tokens:  2000,
    temperature: 0,
  });
  const raw    = resp.choices[0].message.content.trim();
  const jsonStr = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  console.log(`[extract/gpt4o/${label}] ${raw.length} chars, ${resp.usage?.total_tokens} tokens`);
  return { jsonStr, usage: resp.usage, model: resp.model };
}


// ─── POST /extract/invoice ────────────────────────────────────────────────────
router.post('/invoice', async (req, res) => {
  try {
    const { pages = [], pdfBase64, knownVendors = [], knownEquipment = [] } = req.body;

    const vendorHint = knownVendors.length > 0
      ? `\nCANONICAL VENDOR LIST — match to exact name if possible: ${knownVendors.slice(0, 20).join(' | ')}. Do NOT append Company/Inc./LLC if not in canonical name.`
      : '';

    let extractedJson, usedMethod, usageStats, modelUsed;

    // ── PATH A: Text extraction (digital PDFs) ────────────────────────────────
    if (pdfBase64) {
      try {
        const buffer   = Buffer.from(pdfBase64, 'base64');
        const pdfData  = await pdfParse(buffer);
        const rawText  = (pdfData.text || '').trim();

        // Quality check: is there enough real text? (>200 chars, <80% whitespace/special)
        const textLength    = rawText.length;
        const alphaNumChars = (rawText.match(/[a-zA-Z0-9$.,]/g) || []).length;
        const textQuality   = textLength > 0 ? alphaNumChars / textLength : 0;
        const hasGoodText   = textLength > 200 && textQuality > 0.35;

        if (hasGoodText) {
          console.log(`[extract] ${textLength} chars, quality ${(textQuality*100).toFixed(0)}% — using ${TEXT_MODEL} text path`);

          const truncated = rawText.length > 6000 ? rawText.slice(0, 6000) + '\n[...truncated]' : rawText;
          const fullPrompt = `${buildPrompt(vendorHint, true)}\n\n--- INVOICE TEXT ---\n${truncated}`;

          let result;
          if (anthropic) {
            result = await callClaude(fullPrompt, 'invoice');
          } else {
            result = await callGPT(fullPrompt, 'text');
          }

          extractedJson = JSON.parse(result.jsonStr);
          usedMethod    = anthropic ? 'claude-text' : 'gpt4o-text';
          usageStats    = result.usage;
          modelUsed     = result.model;
        } else {
          console.log(`[extract/text] Text too sparse (${textLength} chars, ${(textQuality*100).toFixed(0)}% quality) — falling back to Vision`);
        }
      } catch (pdfErr) {
        console.warn('[extract/text] pdf-parse failed:', pdfErr.message, '— falling back to Vision');
      }
    }

    // ── PATH B: Vision (scanned PDFs or text extraction fallback) ────────────
    if (!extractedJson) {
      if (!pages || pages.length === 0) {
        return res.status(400).json({ error: 'pages array required for vision extraction (no text layer found)' });
      }

      const content = [
        { type: 'text', text: buildPrompt(vendorHint, false) },
        ...pages.slice(0, 4).map(page => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${page}`, detail: 'high' }
        }))
      ];

      const { jsonStr, usage, model } = await callGPT(content, 'vision');
      extractedJson = JSON.parse(jsonStr);
      usedMethod    = 'vision';
      usageStats    = usage;
      modelUsed     = model;
    }

    // ── Build response ────────────────────────────────────────────────────────
    const source  = usedMethod === 'claude-text' ? 'Claude Text' : usedMethod === 'gpt4o-text' ? 'GPT-4o Text' : 'GPT-4o Vision';
    const fields  = buildFields(extractedJson, source);
    const withData = Object.values(fields).filter(f => f.value !== null).length;
    const highConf = Object.values(fields).filter(f => f.confidence === 'HIGH').length;
    const pctHigh  = withData > 0 ? Math.round(highConf / withData * 100) : 0;

    console.log(`[extract/${usedMethod}] ${withData} fields, ${pctHigh}% HIGH confidence`);

    res.json({
      success:    true,
      fields,
      lineItems:  extractedJson.lineItems || [],
      fullText:   `${source} extracted ${withData} fields (${pctHigh}% high confidence). Method: ${usedMethod}.`,
      confidence: { high: highConf, total: withData, pct: pctHigh },
      method:     usedMethod,
      model:      modelUsed,
      usage:      usageStats,
    });

  } catch (err) {
    console.error('[/extract/invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { extractRouter: router };
