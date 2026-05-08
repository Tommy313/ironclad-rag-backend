/**
 * IRONCLAD REPORT GENERATOR
 * POST /report/generate
 *
 * Accepts a structured "brief data" payload from the frontend and returns
 * a professionally formatted Cost Intelligence Brief as a PDF binary.
 *
 * Payload shape:
 * {
 *   client:       string,          // "Ferrous Process & Trading"
 *   preparedBy:   string,          // "Ironclad Fleet Intelligence"
 *   dateRange:    { start, end },  // ISO date strings
 *   invoices:     [...],           // audited invoice objects
 *   vendors:      [...],           // vendor registry entries
 *   findings:     [...],           // pre-computed top findings (see shape below)
 *   benchmarks:   [...],           // per-vendor rate benchmark rows
 *   summary:      string,          // 2-3 sentence exec summary (optional override)
 * }
 *
 * Finding shape:
 * { rank, title, invoiceId, vendor, amount, dollarImpact, evidence, category }
 *
 * Benchmark shape:
 * { vendor, billedRate, contractRate, ironcladBenchmark, variance, status }
 */

const express = require('express');
const PDFDocument = require('pdfkit');

const router = express.Router();

// ── Brand colors ─────────────────────────────────────────────────────────────
const C = {
  ironBlue:   '#1a2744',   // dark navy — headers, titles
  ironGold:   '#c8972b',   // gold accent — dividers, highlights
  ironRed:    '#b91c1c',   // flag red — findings
  ironGreen:  '#15803d',   // compliant green
  ironGray:   '#64748b',   // body text secondary
  white:      '#ffffff',
  lightGray:  '#f1f5f9',
  midGray:    '#e2e8f0',
};

const f$ = (n) => n != null ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—';
const fRate = (n) => n != null ? '$' + Number(n).toFixed(2) + '/hr' : '—';
const fDate = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};
const today = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

// ── Layout helpers ────────────────────────────────────────────────────────────
const PAGE_W  = 612;   // letter width pt
const PAGE_H  = 792;   // letter height pt
const MARGIN  = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

function hline(doc, y, color = C.midGray, width = CONTENT_W) {
  doc.save().strokeColor(color).lineWidth(0.5)
    .moveTo(MARGIN, y).lineTo(MARGIN + width, y).stroke().restore();
}

function thickLine(doc, y, color = C.ironGold) {
  doc.save().strokeColor(color).lineWidth(2)
    .moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke().restore();
}

function sectionHeader(doc, text, y) {
  doc.save()
    .fontSize(9).font('Helvetica-Bold')
    .fillColor(C.ironBlue)
    .text(text.toUpperCase(), MARGIN, y, { characterSpacing: 1.2 })
    .restore();
  thickLine(doc, y + 14, C.ironGold);
  return y + 22;
}

function badge(doc, text, x, y, bgColor, textColor = C.white) {
  const pad = 4;
  doc.save().fontSize(7).font('Helvetica-Bold');
  const tw = doc.widthOfString(text);
  doc.roundedRect(x, y - 1, tw + pad * 2, 12, 2).fill(bgColor);
  doc.fillColor(textColor).text(text, x + pad, y, { lineBreak: false });
  doc.restore();
  return tw + pad * 2 + 6;
}

function statusColor(status) {
  if (!status) return C.ironGray;
  const s = status.toString().toUpperCase();
  if (s === 'FLAG' || s === 'OVER')    return C.ironRed;
  if (s === 'PASS' || s === 'OK')      return C.ironGreen;
  if (s === 'NOTE' || s === 'NEAR')    return '#b45309';
  return C.ironGray;
}

// ── Main PDF builder ──────────────────────────────────────────────────────────
function buildReport(data) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'letter', margin: 0, info: {
      Title:   `Ironclad Cost Intelligence Brief — ${data.client}`,
      Author:  'Ironclad Fleet Intelligence',
      Subject: 'Fleet Vendor Cost Audit',
      Creator: 'Ironclad Fleet Intelligence v1',
    }});

    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { client, preparedBy = 'Ironclad Fleet Intelligence', dateRange = {},
            invoices = [], vendors = [], findings = [], benchmarks = [] } = data;

    const invoiceCount   = invoices.length;
    const flaggedCount   = invoices.filter(i => (i.flags || []).some(f => f.startsWith('ENG-') || f !== '')).length;
    const totalAuditValue = invoices.reduce((s, i) => s + (i.labor || 0) + (i.parts || 0) + (i.misc || 0), 0);
    const vendorsCovered  = [...new Set(invoices.map(i => i.vendor).filter(Boolean))];
    const topFindings     = findings.slice(0, 5);
    const totalExposure   = topFindings.reduce((s, f) => s + (f.dollarImpact || 0), 0);

    // ── PAGE 1: Cover + Scope + Exec Summary ──────────────────────────────────

    // Navy header band
    doc.rect(0, 0, PAGE_W, 110).fill(C.ironBlue);

    // Gold accent bar
    doc.rect(0, 108, PAGE_W, 3).fill(C.ironGold);

    // Logo / wordmark
    doc.save()
      .fontSize(22).font('Helvetica-Bold').fillColor(C.white)
      .text('IRONCLAD', MARGIN, 28, { lineBreak: false });
    doc.fontSize(10).font('Helvetica').fillColor(C.ironGold)
      .text('  FLEET INTELLIGENCE', MARGIN + 108, 35, { lineBreak: false });

    // Report type tag
    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
      .text('COST INTELLIGENCE BRIEF', MARGIN, 60)
      .text('CONFIDENTIAL — PREPARED FOR AUTHORIZED RECIPIENT ONLY', MARGIN, 73);

    // Date top-right
    doc.fontSize(8).fillColor('#94a3b8')
      .text(today(), 0, 32, { align: 'right', width: PAGE_W - MARGIN });

    doc.restore();

    // Client block
    let y = 130;
    doc.save()
      .fontSize(18).font('Helvetica-Bold').fillColor(C.ironBlue)
      .text(client || 'Client Name', MARGIN, y);
    y += 26;
    doc.fontSize(10).font('Helvetica').fillColor(C.ironGray)
      .text(`Audit Period: ${fDate(dateRange.start)} – ${fDate(dateRange.end)}`, MARGIN, y);
    y += 14;
    doc.text(`Prepared by: ${preparedBy}   |   Date: ${today()}`, MARGIN, y);
    y += 28;

    hline(doc, y);
    y += 16;

    // ── Scope metrics row ──
    y = sectionHeader(doc, 'Audit Scope', y);
    y += 8;

    const metrics = [
      { label: 'Invoices Audited',   value: invoiceCount.toString() },
      { label: 'Vendors Reviewed',   value: vendorsCovered.length.toString() },
      { label: 'Invoices Flagged',   value: flaggedCount.toString() },
      { label: 'Total Audit Value',  value: f$(totalAuditValue) },
      { label: 'Total Exposure',     value: f$(totalExposure) },
    ];

    const boxW  = Math.floor(CONTENT_W / metrics.length) - 4;
    metrics.forEach((m, i) => {
      const bx = MARGIN + i * (boxW + 5);
      doc.save()
        .rect(bx, y, boxW, 52).fill(C.lightGray)
        .fontSize(18).font('Helvetica-Bold')
        .fillColor(m.label === 'Total Exposure' && totalExposure > 0 ? C.ironRed : C.ironBlue)
        .text(m.value, bx + 6, y + 8, { width: boxW - 12, align: 'center' })
        .fontSize(7).font('Helvetica').fillColor(C.ironGray)
        .text(m.label.toUpperCase(), bx + 6, y + 36, { width: boxW - 12, align: 'center', characterSpacing: 0.5 })
        .restore();
    });
    y += 64;

    // ── Vendors covered ──
    doc.save().fontSize(8).font('Helvetica').fillColor(C.ironGray)
      .text('Vendors covered: ' + (vendorsCovered.join(' · ') || 'None'), MARGIN, y, { width: CONTENT_W });
    y += doc.heightOfString('Vendors covered: ' + vendorsCovered.join(' · '), { width: CONTENT_W, fontSize: 8 }) + 16;
    doc.restore();

    hline(doc, y);
    y += 16;

    // ── Executive Summary ──
    y = sectionHeader(doc, 'Executive Summary', y);
    y += 8;

    const autoSummary = data.summary || buildAutoSummary(client, invoiceCount, vendorsCovered, topFindings, totalExposure, totalAuditValue);
    doc.save()
      .fontSize(10).font('Helvetica').fillColor('#1e293b')
      .text(autoSummary, MARGIN, y, { width: CONTENT_W, lineGap: 3 });
    y += doc.heightOfString(autoSummary, { width: CONTENT_W, fontSize: 10, lineGap: 3 }) + 20;
    doc.restore();

    // ── Page 1 footer ──
    pageFooter(doc, 1, client);

    // ── PAGE 2: Rate Benchmark + Findings ─────────────────────────────────────
    doc.addPage();
    y = MARGIN;

    // Page 2 mini-header
    doc.save().rect(0, 0, PAGE_W, 36).fill(C.ironBlue).restore();
    doc.save().fontSize(9).font('Helvetica-Bold').fillColor(C.white)
      .text('IRONCLAD FLEET INTELLIGENCE', MARGIN, 12)
      .fontSize(8).font('Helvetica').fillColor('#94a3b8')
      .text(`Cost Intelligence Brief  —  ${client}`, MARGIN, 23).restore();
    doc.save().rect(0, 34, PAGE_W, 2).fill(C.ironGold).restore();
    y = 52;

    // ── Rate Benchmark Table ──
    if (benchmarks.length > 0) {
      y = sectionHeader(doc, 'Rate Benchmark Analysis', y);
      y += 8;

      // Table header
      const cols = [
        { label: 'Vendor',            x: MARGIN,       w: 150 },
        { label: 'Billed Rate',       x: MARGIN + 155, w: 80  },
        { label: 'Contract Rate',     x: MARGIN + 240, w: 80  },
        { label: 'Benchmark',         x: MARGIN + 325, w: 80  },
        { label: 'Variance',          x: MARGIN + 410, w: 70  },
        { label: 'Status',            x: MARGIN + 485, w: 55  },
      ];

      doc.save().rect(MARGIN, y, CONTENT_W, 18).fill(C.ironBlue).restore();
      cols.forEach(col => {
        doc.save().fontSize(7).font('Helvetica-Bold').fillColor(C.white)
          .text(col.label, col.x + 4, y + 5, { width: col.w - 4 }).restore();
      });
      y += 18;

      benchmarks.forEach((row, idx) => {
        const rowH = 20;
        const bg = idx % 2 === 0 ? C.white : C.lightGray;
        doc.save().rect(MARGIN, y, CONTENT_W, rowH).fill(bg).restore();

        const variance = row.variance != null ? row.variance : (
          row.billedRate != null && row.contractRate != null
            ? row.billedRate - row.contractRate : null
        );
        const status = row.status || (variance == null ? '—' : variance > 2 ? 'OVER' : variance < -2 ? 'UNDER' : 'OK');
        const sc = statusColor(status);

        const rowData = [
          { x: cols[0].x, w: cols[0].w, val: row.vendor || '—',             color: C.ironBlue,  bold: true },
          { x: cols[1].x, w: cols[1].w, val: fRate(row.billedRate),          color: '#1e293b',   bold: false },
          { x: cols[2].x, w: cols[2].w, val: fRate(row.contractRate),        color: '#1e293b',   bold: false },
          { x: cols[3].x, w: cols[3].w, val: fRate(row.ironcladBenchmark),   color: C.ironGray,  bold: false },
          { x: cols[4].x, w: cols[4].w, val: variance != null ? (variance > 0 ? '+' : '') + fRate(variance) : '—', color: sc, bold: variance != null && Math.abs(variance) > 2 },
          { x: cols[5].x, w: cols[5].w, val: status,                         color: sc,          bold: true },
        ];
        rowData.forEach(cell => {
          doc.save().fontSize(8)
            .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
            .fillColor(cell.color)
            .text(cell.val, cell.x + 4, y + 6, { width: cell.w - 6 }).restore();
        });

        // Draw thin bottom border
        doc.save().strokeColor(C.midGray).lineWidth(0.3)
          .moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).stroke().restore();
        y += rowH;
      });

      y += 20;
    }

    // ── Top Findings ──
    if (topFindings.length > 0) {
      if (y > PAGE_H - 220) { doc.addPage(); y = MARGIN; }

      y = sectionHeader(doc, `Top Findings (${topFindings.length})`, y);
      y += 8;

      topFindings.forEach((finding, idx) => {
        // Check if we need a new page
        if (y > PAGE_H - 120) {
          pageFooter(doc, 2, client);
          doc.addPage();
          y = MARGIN;
          // Mini-header on continuation pages
          doc.save().rect(0, 0, PAGE_W, 36).fill(C.ironBlue).restore();
          doc.save().fontSize(9).font('Helvetica-Bold').fillColor(C.white)
            .text('IRONCLAD FLEET INTELLIGENCE', MARGIN, 12)
            .fontSize(8).font('Helvetica').fillColor('#94a3b8')
            .text(`Cost Intelligence Brief  —  ${client}`, MARGIN, 23).restore();
          doc.save().rect(0, 34, PAGE_W, 2).fill(C.ironGold).restore();
          y = 52;
        }

        const findingH = estimateFindingHeight(doc, finding);
        const impactPositive = (finding.dollarImpact || 0) > 0;

        // Finding card border
        doc.save().rect(MARGIN, y, CONTENT_W, findingH)
          .strokeColor(impactPositive ? '#fca5a5' : C.midGray)
          .lineWidth(0.5).stroke().restore();

        // Left accent bar
        doc.save().rect(MARGIN, y, 4, findingH).fill(impactPositive ? C.ironRed : C.ironGray).restore();

        const cx = MARGIN + 10;
        const cw = CONTENT_W - 14;
        let cy = y + 8;

        // Rank + title + impact
        doc.save().fontSize(8).font('Helvetica-Bold').fillColor(C.ironGray)
          .text(`#${idx + 1}`, cx, cy, { lineBreak: false, continued: false });
        doc.fontSize(10).font('Helvetica-Bold').fillColor(C.ironBlue)
          .text(finding.title || 'Finding', cx + 20, cy, { width: cw - 120, lineBreak: false });

        if (finding.dollarImpact) {
          doc.save().fontSize(11).font('Helvetica-Bold')
            .fillColor(impactPositive ? C.ironRed : C.ironGreen)
            .text(f$(finding.dollarImpact) + ' exposure', MARGIN + CONTENT_W - 120, cy, { width: 110, align: 'right' })
            .restore();
        }
        cy += 16;

        // Metadata row
        const meta = [
          finding.invoiceId  ? `Invoice: ${finding.invoiceId}` : null,
          finding.vendor     ? `Vendor: ${finding.vendor}` : null,
          finding.category   ? `Category: ${finding.category}` : null,
        ].filter(Boolean).join('   ·   ');

        if (meta) {
          doc.save().fontSize(8).font('Helvetica').fillColor(C.ironGray)
            .text(meta, cx, cy, { width: cw }).restore();
          cy += 13;
        }

        // Evidence
        if (finding.evidence) {
          doc.save().fontSize(9).font('Helvetica').fillColor('#334155')
            .text(finding.evidence, cx, cy, { width: cw, lineGap: 2 }).restore();
          cy += doc.heightOfString(finding.evidence, { width: cw, fontSize: 9, lineGap: 2 }) + 4;
        }

        y += findingH + 8;
        doc.restore();
      });
    }

    // ── PAGE 3: Primary Recommendation + Sign-off ─────────────────────────────
    pageFooter(doc, 2, client);
    doc.addPage();
    y = MARGIN;

    doc.save().rect(0, 0, PAGE_W, 36).fill(C.ironBlue).restore();
    doc.save().fontSize(9).font('Helvetica-Bold').fillColor(C.white)
      .text('IRONCLAD FLEET INTELLIGENCE', MARGIN, 12)
      .fontSize(8).font('Helvetica').fillColor('#94a3b8')
      .text(`Cost Intelligence Brief  —  ${client}`, MARGIN, 23).restore();
    doc.save().rect(0, 34, PAGE_W, 2).fill(C.ironGold).restore();
    y = 52;

    y = sectionHeader(doc, 'Primary Recommendation', y);
    y += 8;

    const primaryFinding = topFindings[0];
    if (primaryFinding) {
      doc.save()
        .rect(MARGIN, y, CONTENT_W, 4).fill(C.ironGold).restore();
      y += 12;

      const rec = data.recommendation || buildAutoRecommendation(primaryFinding, topFindings, totalExposure);
      doc.save()
        .fontSize(12).font('Helvetica-Bold').fillColor(C.ironBlue)
        .text(rec.headline || 'Review and dispute flagged invoices with vendor.', MARGIN, y, { width: CONTENT_W });
      y += 22;
      if (rec.body) {
        doc.save().fontSize(10).font('Helvetica').fillColor('#1e293b')
          .text(rec.body, MARGIN, y, { width: CONTENT_W, lineGap: 3 }).restore();
        y += doc.heightOfString(rec.body, { width: CONTENT_W, fontSize: 10, lineGap: 3 }) + 16;
      }
      if (rec.steps && rec.steps.length > 0) {
        rec.steps.forEach((step, i) => {
          doc.save().fontSize(9).font('Helvetica-Bold').fillColor(C.ironBlue)
            .text(`${i + 1}.`, MARGIN, y, { continued: true, lineBreak: false })
            .font('Helvetica').fillColor('#1e293b')
            .text('  ' + step, { width: CONTENT_W - 20 }).restore();
          y += 16;
        });
      }
      y += 12;
    }

    hline(doc, y);
    y += 20;

    // ── Next steps box ──
    y = sectionHeader(doc, 'Suggested Next Steps', y);
    y += 8;
    const nextSteps = data.nextSteps || [
      'Share this brief with your procurement or operations lead.',
      'Request itemized labor tickets for all flagged invoices.',
      'Schedule a vendor meeting to dispute rate and travel billing discrepancies.',
      'Consider a Tier 2 Full Vendor Cost Audit to quantify exposure across all vendors.',
    ];
    nextSteps.forEach((step, i) => {
      doc.save().fontSize(9).font('Helvetica').fillColor('#334155')
        .text(`${i + 1}.  ${step}`, MARGIN, y, { width: CONTENT_W - 20, lineGap: 2 }).restore();
      y += 18;
    });

    y += 20;
    hline(doc, y);
    y += 24;

    // ── Signature / contact block ──
    doc.save()
      .fontSize(11).font('Helvetica-Bold').fillColor(C.ironBlue)
      .text('Ironclad Fleet Intelligence', MARGIN, y)
      .fontSize(9).font('Helvetica').fillColor(C.ironGray)
      .text('Fleet Vendor Cost Audit Services', MARGIN, y + 16)
      .text('This report is confidential and prepared exclusively for the named recipient.', MARGIN, y + 32, { width: CONTENT_W })
      .restore();

    pageFooter(doc, 3, client);
    doc.end();
  });
}

// ── Auto-generated text helpers ───────────────────────────────────────────────
function buildAutoSummary(client, invoiceCount, vendors, findings, totalExposure, totalValue) {
  const vendorList = vendors.slice(0, 3).join(', ') + (vendors.length > 3 ? ` and ${vendors.length - 3} others` : '');
  const pct = totalValue > 0 ? Math.round(totalExposure / totalValue * 100) : 0;
  if (findings.length === 0) {
    return `Ironclad Fleet Intelligence reviewed ${invoiceCount} vendor invoices for ${client || 'this client'} ` +
           `covering ${vendorList}. No material billing discrepancies were identified in this sample. ` +
           `All invoices reviewed were consistent with applicable vendor agreements and market rate benchmarks.`;
  }
  return `Ironclad Fleet Intelligence reviewed ${invoiceCount} vendor invoices for ${client || 'this client'} ` +
         `covering ${vendorList}. Our analysis identified ${findings.length} billing discrepanc${findings.length === 1 ? 'y' : 'ies'} ` +
         `representing ${f$(totalExposure)} in potential exposure ` +
         (pct > 0 ? `(${pct}% of total audit value). ` : '. ') +
         `The primary finding involves ${findings[0]?.vendor || 'a vendor'}: ${(findings[0]?.title || '').toLowerCase() || 'rate and billing irregularities'}. ` +
         `Ironclad recommends prompt follow-up with the vendor to recover or prevent these charges.`;
}

function buildAutoRecommendation(primary, allFindings, totalExposure) {
  const headline = primary
    ? `Dispute ${primary.vendor || 'vendor'} billing discrepancy — ${f$(primary.dollarImpact)} at risk`
    : 'Initiate vendor billing review';

  const body = allFindings.length > 1
    ? `This audit identified ${allFindings.length} findings totaling ${f$(totalExposure)} in billing exposure. ` +
      `The highest-priority item is the ${primary?.title?.toLowerCase() || 'rate discrepancy'} on ${primary?.vendor || 'the primary vendor'} account. ` +
      `We recommend addressing findings in order of dollar impact.`
    : `The ${primary?.title?.toLowerCase() || 'billing discrepancy'} on ${primary?.vendor || 'this vendor'} account ` +
      `represents ${f$(primary?.dollarImpact)} in billing exposure that warrants immediate follow-up.`;

  const steps = [
    `Request complete itemized labor tickets for invoice${primary?.invoiceId ? ' ' + primary.invoiceId : 's'} from ${primary?.vendor || 'the vendor'}.`,
    `Compare billed rates against your executed vendor agreement.`,
    `Issue a formal billing dispute in writing, citing specific contract terms.`,
    `Track resolution and validate any credit issued against original invoice amounts.`,
  ];

  return { headline, body, steps };
}

function estimateFindingHeight(doc, finding) {
  let h = 28; // rank + title row
  if (finding.invoiceId || finding.vendor || finding.category) h += 14;
  if (finding.evidence) {
    h += doc.heightOfString(finding.evidence || '', { width: CONTENT_W - 14, fontSize: 9, lineGap: 2 }) + 8;
  }
  return Math.max(h + 12, 60);
}

function pageFooter(doc, pageNum, client) {
  const fy = PAGE_H - 28;
  doc.save()
    .rect(0, PAGE_H - 36, PAGE_W, 36).fill(C.ironBlue)
    .fontSize(7).font('Helvetica').fillColor('#94a3b8')
    .text(`IRONCLAD FLEET INTELLIGENCE  ·  CONFIDENTIAL  ·  ${client || ''}`, MARGIN, fy, { lineBreak: false })
    .text(`Page ${pageNum}`, 0, fy, { align: 'right', width: PAGE_W - MARGIN })
    .restore();
}

// ── Route handler ─────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    const data = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Request body must be JSON with report data.' });
    }

    const pdfBuffer = await buildReport(data);

    const filename = `Ironclad_Brief_${(data.client || 'Client').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[report] PDF generation error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to generate report.', detail: err.message });
  }
});

module.exports = { reportRouter: router };
