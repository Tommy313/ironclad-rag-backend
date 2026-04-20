/**
 * EXTRACT ROUTES — GPT-4o Vision invoice extraction
 *
 * POST /extract/invoice  — Send base64 PDF page images, get structured invoice fields back
 *
 * This is the production-grade replacement for naive regex OCR.
 * Works on scanned PDFs, image-based invoices, handwritten notes, dealer layouts.
 */

const express = require('express');
const router  = express.Router();
const OpenAI  = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// ─── POST /extract/invoice ────────────────────────────────────────────────────
// Accepts base64 page images from the frontend (rendered from PDF via pdfjs canvas).
// Sends to gpt-4o vision with a structured extraction prompt.
// Returns annotated fields in the same format IngestPanel expects.

router.post('/invoice', async (req, res) => {
  try {
    const { pages, knownVendors = [], knownEquipment = [] } = req.body;

    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: 'pages array is required (base64 image strings)' });
    }

    console.log(`[/extract/invoice] Processing ${pages.length} page(s)`);

    // Build context hints to improve extraction accuracy
    const vendorHint = knownVendors.length > 0
      ? `\nKnown vendors in this fleet: ${knownVendors.slice(0, 10).join(', ')}.`
      : '';

    const prompt = `You are an expert at reading heavy equipment dealer repair invoices (CAT, Sennebogen, Volvo, John Deere, Komatsu, etc.).

Extract ALL invoice fields visible in this image and return a single JSON object. Be precise — this data feeds a financial audit engine.
${vendorHint}

Return ONLY this JSON structure, no markdown, no explanation:
{
  "invoiceNumber": "invoice or work order number, e.g. SWA877183",
  "vendor": "dealer or vendor company name",
  "date": "invoice date as YYYY-MM-DD",
  "workDates": "actual service/work dates as written, e.g. '11/10/25' or '10/7, 10/9/25'",
  "equipment": "full equipment description, e.g. 'Sennebogen 840 M E'",
  "serialNumber": "machine serial number",
  "unitId": "fleet/unit ID number if shown",
  "site": "job site or location address",
  "meterHours": 12345,
  "laborTotal": 1840.00,
  "partsTotal": 58.29,
  "miscTotal": 0.00,
  "grandTotal": 1898.29,
  "techs": ["Tech Name 1", "Tech Name 2"],
  "visits": 1,
  "description": "complete description of all work performed, diagnostic steps, findings, and parts used",
  "lineItems": [
    { "description": "part or labor description", "quantity": 1, "unitPrice": 58.29, "total": 58.29 }
  ],
  "region": "geographic region if shown",
  "agreementType": "resident or contract type if mentioned"
}

Rules:
- Return null for any field not clearly visible in the invoice.
- laborTotal = sum of all labor line items only.
- partsTotal = sum of all parts/materials line items only.
- miscTotal = travel, fuel surcharge, shop supplies, misc fees — everything that is not labor or parts.
- grandTotal = the final invoice total as printed.
- For lineItems: extract every line item on the invoice with its description, qty, unit price, and line total.
- For description: write a complete narrative combining all work notes, repair descriptions, and findings.
- For techs: extract technician/mechanic names from the invoice or labor lines.
- For date: use the invoice date, not the work/service dates.
- Numbers must be plain numbers (no $ sign, no commas).`;

    // Build content array: prompt text + all page images
    const content = [
      { type: 'text', text: prompt },
      ...pages.slice(0, 4).map(page => ({
        type: 'image_url',
        image_url: {
          url:    `data:image/jpeg;base64,${page}`,
          detail: 'high'
        }
      }))
    ];

    const resp = await openai.chat.completions.create({
      model:       'gpt-4o',
      messages:    [{ role: 'user', content }],
      max_tokens:  2000,
      temperature: 0    // Zero temp = deterministic, no hallucination
    });

    const raw = resp.choices[0].message.content.trim();
    console.log(`[/extract/invoice] GPT-4o response (${raw.length} chars), tokens used: ${resp.usage?.total_tokens}`);

    // Strip markdown code fences if model wraps anyway
    const jsonStr = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[/extract/invoice] JSON parse failed. Raw response:', raw.slice(0, 400));
      return res.status(422).json({
        error: 'Vision extraction succeeded but response was not valid JSON',
        raw:   raw.slice(0, 500)
      });
    }

    // ── Convert to confidence-annotated format IngestPanel expects ─────────────
    const conf = (val, high = true) => ({
      value:      val ?? null,
      confidence: val != null && val !== '' ? (high ? 'HIGH' : 'MEDIUM') : null,
      source:     val != null ? 'GPT-4o Vision' : 'Not found in invoice'
    });

    const fields = {
      invoiceNumber: conf(extracted.invoiceNumber),
      vendor:        conf(extracted.vendor),
      date:          conf(extracted.date),
      workDates:     conf(extracted.workDates, false),
      equipment:     conf(extracted.equipment),
      sn:            conf(extracted.serialNumber),
      unitId:        conf(extracted.unitId, false),
      site:          conf(extracted.site, false),
      meter:         conf(extracted.meterHours, false),
      labor:         conf(extracted.laborTotal),
      parts:         conf(extracted.partsTotal),
      misc:          conf(extracted.miscTotal, false),
      total:         conf(extracted.grandTotal),
      techs:         conf(Array.isArray(extracted.techs) && extracted.techs.length ? extracted.techs.join(', ') : null, false),
      visits:        conf(extracted.visits || 1, false),
      description:   conf(extracted.description),
    };

    const withData  = Object.values(fields).filter(f => f.value !== null).length;
    const highConf  = Object.values(fields).filter(f => f.confidence === 'HIGH').length;
    const pctHigh   = withData > 0 ? Math.round(highConf / withData * 100) : 0;

    console.log(`[/extract/invoice] Extracted ${withData} fields, ${pctHigh}% HIGH confidence`);

    res.json({
      success:   true,
      fields,
      lineItems: extracted.lineItems  || [],
      fullText:  `GPT-4o Vision extracted ${withData} fields (${pctHigh}% high confidence).`,
      confidence: { high: highConf, total: withData, pct: pctHigh },
      model:     resp.model,
      usage:     resp.usage
    });

  } catch (err) {
    console.error('[/extract/invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});


module.exports = { extractRouter: router };
