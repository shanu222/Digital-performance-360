import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import type { ReportChart, ReportDoc, ReportTable } from './builder.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from '../../lib/util.js';

// Unicode-capable embedded font (keywords, page titles and country names can be non-Latin)
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');

const NAVY = '#0b1324';
const CYAN = '#06b6d4';
const GOLD = '#d4a017';
const MUTED = '#64748b';
// validated categorical order (light surface): blue, orange, aqua, yellow
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];

/* ============================== PDF ============================== */

export async function renderPdf(doc: ReportDoc): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: doc.title, Author: 'Digital Performance 360' } });
  pdf.registerFont('Sans', path.join(FONT_DIR, 'DejaVuSansCondensed.ttf'));
  pdf.registerFont('Sans-Bold', path.join(FONT_DIR, 'DejaVuSansCondensed-Bold.ttf'));
  pdf.registerFont('Sans-Oblique', path.join(FONT_DIR, 'DejaVuSansCondensed-Oblique.ttf'));
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const W = pdf.page.width - 84;

  // Cover band
  pdf.rect(0, 0, pdf.page.width, 120).fill(NAVY);
  pdf.fillColor(CYAN).fontSize(9).font('Sans-Bold').text('DIGITAL PERFORMANCE 360', 42, 34, { characterSpacing: 2 });
  pdf.fillColor('#ffffff').fontSize(20).text(doc.title, 42, 52, { width: W });
  pdf.fillColor('#cbd5e1').fontSize(9).font('Sans').text(doc.subtitle, 42, 88, { width: W });
  pdf.y = 140;
  pdf.fillColor(MUTED).fontSize(8).text(`Generated ${new Date(doc.generatedAt).toUTCString()} · Sources: ${doc.sources.join(', ')}`, { width: W });
  pdf.moveDown(1);

  // Executive summary
  heading(pdf, 'Executive summary');
  pdf.font('Sans').fontSize(10).fillColor('#0f172a');
  for (const line of doc.executiveSummary) {
    pdf.text(`•  ${line}`, { width: W, paragraphGap: 3 });
  }
  pdf.moveDown(0.8);

  for (const s of doc.sections) {
    ensure(pdf, 80);
    heading(pdf, s.title);
    if (s.note) {
      pdf.font('Sans-Oblique').fontSize(8).fillColor(MUTED).text(s.note, { width: W });
      pdf.moveDown(0.4);
    }
    if (s.callouts?.length) drawCallouts(pdf, s.callouts, W);
    if (s.actions?.length) drawActions(pdf, s.actions, W);
    if (s.kpis?.length) drawKpis(pdf, s.kpis, W);
    if (s.chart && s.chart.labels.length > 0) drawChart(pdf, s.chart, W);
    if (s.table) drawTable(pdf, s.table, W);
    if (s.definitions?.length) drawTable(pdf, { title: 'Definitions', headers: ['Metric', 'Formula', 'Meaning'], rows: s.definitions.map((d) => [d.term, d.formula, d.meaning]) }, W, [0.2, 0.36, 0.44]);
    pdf.moveDown(0.6);
  }

  // Footer with page numbers
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.font('Sans').fontSize(7).fillColor(MUTED);
    pdf.text(`Digital Performance 360 · Monitor. Analyze. Optimize. Grow.   Page ${i + 1} of ${range.count}`, 42, pdf.page.height - 30, { width: W, align: 'center', lineBreak: false });
  }
  pdf.end();
  return done;
}

function ensure(pdf: PDFKit.PDFDocument, h: number) {
  if (pdf.y + h > pdf.page.height - 50) pdf.addPage();
}

function heading(pdf: PDFKit.PDFDocument, t: string) {
  pdf.font('Sans-Bold').fontSize(13).fillColor(NAVY).text(t);
  const y = pdf.y + 2;
  pdf.moveTo(42, y).lineTo(90, y).lineWidth(2).strokeColor(GOLD).stroke();
  pdf.moveDown(0.6);
}

function drawKpis(pdf: PDFKit.PDFDocument, kpis: NonNullable<ReportDoc['sections'][number]['kpis']>, W: number) {
  const cols = 3;
  const gap = 8;
  const cw = (W - gap * (cols - 1)) / cols;
  const ch = 46;
  for (let i = 0; i < kpis.length; i += cols) {
    ensure(pdf, ch + 8);
    const y = pdf.y;
    kpis.slice(i, i + cols).forEach((k, j) => {
      const x = 42 + j * (cw + gap);
      pdf.roundedRect(x, y, cw, ch, 4).fillAndStroke('#f1f5f9', '#e2e8f0');
      pdf.font('Sans').fontSize(7.5).fillColor(MUTED).text(k.label.toUpperCase(), x + 8, y + 7, { width: cw - 16 });
      pdf.font('Sans-Bold').fontSize(13).fillColor(NAVY).text(k.value, x + 8, y + 19, { width: cw - 16 });
      if (k.change) {
        const neg = k.change.startsWith('-');
        pdf.font('Sans').fontSize(7.5).fillColor(neg ? '#b91c1c' : '#15803d').text(k.change, x + 8, y + 35, { width: cw - 16 });
      }
    });
    pdf.y = y + ch + 8;
  }
  pdf.x = 42;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

function drawChart(pdf: PDFKit.PDFDocument, c: ReportChart, W: number) {
  const H = 150;
  ensure(pdf, H + 40);
  pdf.font('Sans-Bold').fontSize(9).fillColor('#0f172a').text(c.title);
  const top = pdf.y + 4;
  const left = 82;
  const width = W - 40;
  const all = c.series.flatMap((s) => s.values).filter((v): v is number => v != null);
  // one shared y-axis for every series (never a dual axis)
  const max = niceMax(Math.max(0, ...all));
  const steps = 4;
  pdf.font('Sans').fontSize(7).fillColor(MUTED);
  for (let i = 0; i <= steps; i++) {
    const y = top + H - (H * i) / steps;
    pdf.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor('#e2e8f0').stroke();
    pdf.text(fmtAxis((max * i) / steps), 42, y - 4, { width: 36, align: 'right' });
  }
  const n = c.labels.length;
  if (c.type === 'bar') {
    const s = c.series[0];
    const bw = Math.max(4, (width / n) * 0.6);
    s.values.forEach((v, i) => {
      if (v == null) return;
      const h = (Math.max(0, v) / max) * H;
      const x = left + (width / n) * i + (width / n - bw) / 2;
      pdf.rect(x, top + H - h, bw, h).fill(PALETTE[0]);
    });
  } else {
    c.series.forEach((s, si) => {
      const smax = max;
      let started = false;
      s.values.forEach((v, i) => {
        if (v == null) {
          started = false;
          return;
        }
        const x = left + (n === 1 ? width / 2 : (width * i) / (n - 1));
        const y = top + H - (Math.max(0, v) / smax) * H;
        if (!started) {
          pdf.moveTo(x, y);
          started = true;
        } else pdf.lineTo(x, y);
      });
      pdf.lineWidth(1.4).strokeColor(PALETTE[si % PALETTE.length]).stroke();
    });
  }
  // x labels (max ~8)
  const every = Math.max(1, Math.ceil(n / 8));
  pdf.fontSize(6.5).fillColor(MUTED);
  c.labels.forEach((l, i) => {
    if (i % every) return;
    const x = c.type === 'bar' ? left + (width / n) * i : left + (n === 1 ? width / 2 : (width * i) / (n - 1));
    pdf.text(l.length > 10 ? l.slice(5) : l, x - 18, top + H + 4, { width: 36, align: 'center', lineBreak: false });
  });
  // legend
  let lx = left;
  const ly = top + H + 16;
  c.series.forEach((s, si) => {
    pdf.rect(lx, ly + 1, 8, 4).fill(PALETTE[si % PALETTE.length]);
    pdf.fillColor('#334155').fontSize(7).text(s.name, lx + 11, ly - 1, { lineBreak: false });
    lx += 110;
  });
  pdf.x = 42;
  pdf.y = ly + 14;
}

function fmtAxis(v: number) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v % 1 ? v.toFixed(2) : String(v);
}

const TONE = { good: ['#ecfdf3', '#15803d'], bad: ['#fef2f2', '#b91c1c'], info: ['#eff6ff', '#1d4ed8'] } as const;

function drawCallouts(pdf: PDFKit.PDFDocument, list: NonNullable<ReportDoc['sections'][number]['callouts']>, W: number) {
  for (const c of list) {
    pdf.font('Sans').fontSize(8.5);
    const h = pdf.heightOfString(c.text, { width: W - 20 }) + 10;
    ensure(pdf, h + 4);
    const y = pdf.y;
    const [bg, fg] = TONE[c.tone];
    pdf.roundedRect(42, y, W, h, 3).fill(bg);
    pdf.rect(42, y, 3, h).fill(fg);
    pdf.fillColor('#0f172a').text(c.text, 52, y + 5, { width: W - 20 });
    pdf.y = y + h + 4;
  }
  pdf.x = 42;
  pdf.moveDown(0.3);
}

const PRIORITY_COLOR = { critical: '#b91c1c', high: '#c2410c', medium: '#1d4ed8', low: '#475569' } as const;

function drawActions(pdf: PDFKit.PDFDocument, list: NonNullable<ReportDoc['sections'][number]['actions']>, W: number) {
  list.forEach((a, i) => {
    pdf.font('Sans').fontSize(8.5);
    const body = `${a.action}`;
    const meta = `Evidence: ${a.evidence}   ·   Expected impact: ${a.impact}${a.source ? `   ·   Source: ${a.source}` : ''}`;
    const h = pdf.heightOfString(body, { width: W - 96 }) + pdf.font('Sans').fontSize(7.5).heightOfString(meta, { width: W - 96 }) + 16;
    ensure(pdf, h + 4);
    const y = pdf.y;
    pdf.roundedRect(42, y, W, h, 4).fillAndStroke(i % 2 ? '#ffffff' : '#f8fafc', '#e2e8f0');
    pdf.roundedRect(50, y + 7, 64, 14, 7).fill(PRIORITY_COLOR[a.priority]);
    pdf.font('Sans-Bold').fontSize(7).fillColor('#ffffff').text(a.priority.toUpperCase(), 50, y + 10.5, { width: 64, align: 'center' });
    pdf.font('Sans').fontSize(6.5).fillColor(MUTED).text(a.area, 50, y + 25, { width: 64, align: 'center' });
    pdf.font('Sans-Bold').fontSize(8.5).fillColor('#0f172a').text(body, 124, y + 7, { width: W - 96 });
    pdf.font('Sans').fontSize(7.5).fillColor('#475569').text(meta, 124, pdf.y + 2, { width: W - 96 });
    pdf.y = y + h + 4;
  });
  pdf.x = 42;
  pdf.moveDown(0.3);
}

const NUMERIC = /^[-+≈]?\s*([A-Z]{3}\s)?[-+]?[\d.,]+\s*(%|pts?|pos|days)?$|^—$/;

function drawTable(pdf: PDFKit.PDFDocument, t: ReportTable, W: number, ratios?: number[]) {
  const maxRows = 60;
  const cols = t.headers.length;
  // first column wider for labels
  const first = Math.min(W * 0.3, Math.max(W / cols, 110));
  const rest = (W - first) / Math.max(1, cols - 1);
  const widths = ratios ? ratios.map((r) => r * W) : t.headers.map((_, i) => (i === 0 ? first : rest));
  const fs = cols > 10 ? 5.8 : cols > 7 ? 6.5 : 7.5;
  const numericCol = t.headers.map((_, i) => !ratios && i > 0 && t.rows.length > 0 && t.rows.every((r) => r[i] == null || typeof r[i] === 'number' || NUMERIC.test(String(r[i]))));

  const drawHeader = () => {
    const y = pdf.y;
    pdf.rect(42, y, W, 16).fill(NAVY);
    let x = 42;
    pdf.font('Sans-Bold').fontSize(fs).fillColor('#ffffff');
    t.headers.forEach((h, i) => {
      pdf.text(h, x + 4, y + 4, { width: widths[i] - 8, align: numericCol[i] ? 'right' : 'left', lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    pdf.y = y + 16;
  };
  ensure(pdf, 40);
  drawHeader();
  const rows = t.rows.slice(0, maxRows);
  rows.forEach((r, ri) => {
    const cellText = r.map((c) => (c == null ? '—' : typeof c === 'number' ? Math.round(c * 100) / 100 + '' : String(c)));
    const h = Math.max(14, ...cellText.map((c, i) => pdf.font('Sans').fontSize(fs).heightOfString(c, { width: widths[i] - 8 }) + 6));
    if (pdf.y + h > pdf.page.height - 50) {
      pdf.addPage();
      drawHeader();
    }
    const y = pdf.y;
    if (ri % 2) pdf.rect(42, y, W, h).fill('#f8fafc');
    let x = 42;
    pdf.font('Sans').fontSize(fs).fillColor('#0f172a');
    cellText.forEach((c, i) => {
      pdf.text(c, x + 4, y + 3, { width: widths[i] - 8, align: numericCol[i] ? 'right' : 'left' });
      x += widths[i];
    });
    pdf.y = y + h;
  });
  if (t.rows.length > maxRows) {
    pdf.font('Sans-Oblique').fontSize(7).fillColor(MUTED).text(`Showing ${maxRows} of ${t.rows.length} rows — download Excel/CSV for the full table.`, 42, pdf.y + 3);
  }
  if (!t.rows.length) pdf.font('Sans-Oblique').fontSize(8).fillColor(MUTED).text('No data available for this period.', 42, pdf.y + 3);
  pdf.x = 42;
  pdf.moveDown(0.5);
}

/* ============================== Excel ============================== */

export async function renderExcel(doc: ReportDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Digital Performance 360';
  wb.created = new Date(doc.generatedAt);

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 34 }, { width: 28 }, { width: 18 }];
  summary.addRow([doc.title]).font = { bold: true, size: 16, color: { argb: 'FF0B1324' } };
  summary.addRow([doc.subtitle]);
  summary.addRow([`Sources: ${doc.sources.join(', ')}`]);
  summary.addRow([`Generated: ${doc.generatedAt}`]);
  summary.addRow([]);
  summary.addRow(['Executive summary']).font = { bold: true };
  doc.executiveSummary.forEach((l) => summary.addRow([l]));
  summary.addRow([]);
  for (const s of doc.sections) {
    if (!s.kpis?.length) continue;
    summary.addRow([s.title]).font = { bold: true };
    summary.addRow(['Metric', 'Value', 'Change']).font = { bold: true };
    s.kpis.forEach((k) => summary.addRow([k.label, k.value, k.change ?? '']));
    summary.addRow([]);
  }

  const used = new Set<string>(['Summary']);
  const sheetName = (t: string) => {
    let base = t.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base.slice(0, 26)} ${i++}`;
    used.add(name);
    return name;
  };

  for (const s of doc.sections) {
    if (s.callouts?.length) {
      summary.addRow([s.title]).font = { bold: true };
      s.callouts.forEach((c) => summary.addRow([`${c.tone === 'bad' ? '⚠ ' : c.tone === 'good' ? '✓ ' : 'ℹ '}${c.text}`]));
      summary.addRow([]);
    }
    if (s.actions?.length) addTableSheet(wb, sheetName('Action plan'), { title: 'Action plan', headers: ['Priority', 'Area', 'Action', 'Evidence', 'Expected impact', 'Source'], rows: s.actions.map((a) => [a.priority.toUpperCase(), a.area, a.action, a.evidence, a.impact, a.source ?? 'Rules']) });
    if (s.definitions?.length) addTableSheet(wb, sheetName('Formulas'), { title: 'Formulas', headers: ['Metric', 'Formula', 'Meaning'], rows: s.definitions.map((d) => [d.term, d.formula, d.meaning]) });
    if (s.table) addTableSheet(wb, sheetName(s.table.title || s.title), s.table);
    if (s.chart && s.chart.labels.length) {
      const ws = wb.addWorksheet(sheetName(`${s.chart.title}`));
      ws.addRow(['Label', ...s.chart.series.map((x) => x.name)]).font = { bold: true };
      s.chart.labels.forEach((l, i) => ws.addRow([l, ...s.chart!.series.map((x) => x.values[i])]));
      ws.columns.forEach((c) => (c.width = 18));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function addTableSheet(wb: ExcelJS.Workbook, name: string, t: ReportTable) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const header = ws.addRow(t.headers);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1324' } }));
  t.rows.forEach((r) => ws.addRow(r.map((v) => (v === null ? '' : v))));
  ws.columns.forEach((c, i) => (c.width = i === 0 ? 48 : 16));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.headers.length } };
}

/* ============================== CSV ============================== */

/** CSV export: every table in the report, separated by a title line. */
export function renderCsv(doc: ReportDoc): Buffer {
  const parts: string[] = [`# ${doc.title}`, `# ${doc.subtitle}`, `# Sources: ${doc.sources.join(', ')}`];
  for (const s of doc.sections) {
    if (s.kpis?.length) {
      parts.push('', `# ${s.title}`, toCsv(['Metric', 'Value', 'Change'], s.kpis.map((k) => [k.label, k.value, k.change ?? ''])));
    }
    if (s.actions?.length) parts.push('', '# Action plan', toCsv(['Priority', 'Area', 'Action', 'Evidence', 'Expected impact'], s.actions.map((a) => [a.priority, a.area, a.action, a.evidence, a.impact])));
    if (s.table) parts.push('', `# ${s.table.title}`, toCsv(s.table.headers, s.table.rows));
    if (s.definitions?.length) parts.push('', '# Formulas', toCsv(['Metric', 'Formula', 'Meaning'], s.definitions.map((d) => [d.term, d.formula, d.meaning])));
  }
  return Buffer.from('﻿' + parts.join('\n'), 'utf8');
}
