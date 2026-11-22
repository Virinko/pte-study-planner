export interface PracticeReportImageGroup {
  type: string;
  color: string;
  softColor: string;
  seconds: number;
  details: { kind: string; text: string; dueDate?: string }[];
}

type TextPart = { text: string; font: string; color: string };
type DetailLine = { kind: string; parts: TextPart[] };
type PageRow = { group: PracticeReportImageGroup; lines: DetailLine[]; y: number; height: number };

const WIDTH = 600;
const HEIGHT = 800;
const OUTPUT_SCALE = 1.8;
const PAGE_MARGIN = 28;
const LIST_TOP = 82;
const LIST_BOTTOM = 772;
const ROW_MIN_HEIGHT = 43;
const LINE_HEIGHT = 15;
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", sans-serif';
const TITLE_FONT = `500 12px ${FONT_FAMILY}`;
const DUE_FONT = `400 11px ${FONT_FAMILY}`;
const KIND_FONT = `500 11px ${FONT_FAMILY}`;
const TYPE_COLUMN = 60;
const TIME_COLUMN = 122;
const ROW_PADDING = 8;
const COLUMN_GAP = 8;
const CONTENT_X = PAGE_MARGIN + ROW_PADDING + TYPE_COLUMN + COLUMN_GAP;
const TITLE_X = CONTENT_X + 42;
const CONTENT_WIDTH = WIDTH - 2 * PAGE_MARGIN - 2 * ROW_PADDING - TYPE_COLUMN - TIME_COLUMN - 2 * COLUMN_GAP - 42;

function measure(ctx: CanvasRenderingContext2D, text: string, font: string) {
  ctx.font = font;
  return ctx.measureText(text).width;
}

function wrapText(ctx: CanvasRenderingContext2D, value: string, font: string, maxWidth: number) {
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  const lines: string[] = [];
  let current = '';
  chars.forEach((char) => {
    if (current && measure(ctx, current + char, font) > maxWidth) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  });
  if (current || !lines.length) lines.push(current);
  return lines;
}

function detailLines(ctx: CanvasRenderingContext2D, group: PracticeReportImageGroup) {
  if (!group.details.length) {
    return [{ kind: '', parts: [{ text: '仅记录学习时长', font: DUE_FONT, color: '#68738b' }] }];
  }

  return group.details.flatMap((detail) => {
    const lines: DetailLine[] = wrapText(ctx, detail.text, TITLE_FONT, CONTENT_WIDTH).map((text, index) => ({
      kind: index === 0 ? detail.kind : '',
      parts: [{ text, font: TITLE_FONT, color: '#172033' }],
    }));
    if (detail.dueDate) {
      const dueText = `原定完成日期 ${detail.dueDate}`;
      const dueLines = wrapText(ctx, dueText, DUE_FONT, CONTENT_WIDTH);
      const last = lines[lines.length - 1];
      const lastWidth = last.parts.reduce((sum, part) => sum + measure(ctx, part.text, part.font), 0);
      if (dueLines.length === 1 && lastWidth + 7 + measure(ctx, dueText, DUE_FONT) <= CONTENT_WIDTH) {
        last.parts.push({ text: dueText, font: DUE_FONT, color: '#68738b' });
      } else {
        dueLines.forEach((text) => lines.push({ kind: '', parts: [{ text, font: DUE_FONT, color: '#68738b' }] }));
      }
    }
    return lines;
  });
}

function rowHeight(lineCount: number) {
  return Math.max(ROW_MIN_HEIGHT, 18 + lineCount * LINE_HEIGHT);
}

function paginate(ctx: CanvasRenderingContext2D, groups: PracticeReportImageGroup[]) {
  const pages: PageRow[][] = [[]];
  let y = LIST_TOP;
  const nextPage = () => { pages.push([]); y = LIST_TOP; };
  const fullPageHeight = LIST_BOTTOM - LIST_TOP;

  groups.forEach((group) => {
    const lines = detailLines(ctx, group);
    if (rowHeight(lines.length) <= fullPageHeight && y + rowHeight(lines.length) > LIST_BOTTOM) nextPage();
    let offset = 0;
    while (offset < lines.length) {
      const available = LIST_BOTTOM - y;
      const count = Math.min(lines.length - offset, Math.floor((available - 18) / LINE_HEIGHT));
      if (available < ROW_MIN_HEIGHT || count < 1) { nextPage(); continue; }
      const chunk = lines.slice(offset, offset + count);
      const height = rowHeight(chunk.length);
      pages[pages.length - 1].push({ group, lines: chunk, y, height });
      y += height;
      offset += count;
      if (offset < lines.length) nextPage();
    }
  });
  return pages;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function alphaColor(hex: string, alpha: number) {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3 ? [...normalized].map((char) => char + char).join('') : normalized;
  const value = Number.parseInt(full, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function drawCalendar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  roundedRect(ctx, x + 1, y + 3, size - 2, size - 4, 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 1, y + 7);
  ctx.lineTo(x + size - 1, y + 7);
  ctx.moveTo(x + 5, y + 1);
  ctx.lineTo(x + 5, y + 5);
  ctx.moveTo(x + size - 5, y + 1);
  ctx.lineTo(x + size - 5, y + 5);
  ctx.stroke();
  ctx.restore();
}

function drawClock(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.arc(centerX, centerY, size / 2 - 1, 0, Math.PI * 2);
  ctx.moveTo(centerX, centerY - size / 3);
  ctx.lineTo(centerX, centerY);
  ctx.lineTo(centerX + size / 4, centerY + size / 7);
  ctx.stroke();
  ctx.restore();
}

function drawHeader(ctx: CanvasRenderingContext2D, date: string, totalSeconds: number, formatDuration: (seconds: number) => string) {
  drawCalendar(ctx, 29, 31, 17, '#6658e7');
  ctx.font = `500 15px ${FONT_FAMILY}`;
  ctx.fillStyle = '#475467';
  ctx.fillText(date, 52, 45);
  const dividerX = 52 + ctx.measureText(date).width + 16;
  ctx.fillStyle = '#dfe3ee';
  ctx.fillRect(dividerX, 29, 1, 19);
  drawClock(ctx, dividerX + 15, 31, 17, '#259e72');
  ctx.font = `500 13px ${FONT_FAMILY}`;
  ctx.fillStyle = '#667085';
  ctx.fillText('总学习时长', dividerX + 38, 44);
  const labelWidth = ctx.measureText('总学习时长').width;
  ctx.font = `600 16px ${FONT_FAMILY}`;
  ctx.fillStyle = '#5b4fc7';
  ctx.fillText(formatDuration(totalSeconds), dividerX + 38 + labelWidth + 8, 45);
  ctx.fillStyle = '#e7e8f0';
  ctx.fillRect(PAGE_MARGIN, 65, WIDTH - PAGE_MARGIN * 2, 1);
}

function drawRow(ctx: CanvasRenderingContext2D, row: PageRow, formatDuration: (seconds: number) => string, isFirst: boolean) {
  const { group, lines, y, height } = row;
  const x = PAGE_MARGIN;
  const width = WIDTH - PAGE_MARGIN * 2;
  const gradient = ctx.createLinearGradient(x, y, x + width, y);
  gradient.addColorStop(0, group.softColor);
  gradient.addColorStop(0.85, '#ffffff');
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, width, height);
  if (!isFirst) {
    ctx.fillStyle = '#e9edf4';
    ctx.fillRect(x, y, width, 1);
  }

  ctx.font = `500 11px ${FONT_FAMILY}`;
  const badgeWidth = Math.max(40, ctx.measureText(group.type).width + 12);
  const badgeX = x + ROW_PADDING;
  const badgeY = y + (height - 18) / 2;
  ctx.save();
  ctx.fillStyle = group.color;
  ctx.shadowColor = alphaColor(group.color, 0.18);
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  roundedRect(ctx, badgeX, badgeY, badgeWidth, 18, 9);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(group.type, badgeX + badgeWidth / 2, badgeY + 12.5);
  ctx.textAlign = 'left';

  const timeText = group.seconds > 0 ? formatDuration(group.seconds) : '未记录用时';
  ctx.font = `500 11px ${FONT_FAMILY}`;
  const timeWidth = ctx.measureText(timeText).width;
  const timeRight = x + width - ROW_PADDING;
  drawClock(ctx, timeRight - timeWidth - 16, y + (height - 12) / 2, 12, group.color);
  ctx.fillStyle = group.color;
  ctx.fillText(timeText, timeRight - timeWidth, y + height / 2 + 4);

  const firstBaseline = y + (height - lines.length * LINE_HEIGHT) / 2 + 11;
  lines.forEach((line, index) => {
    const baseline = firstBaseline + index * LINE_HEIGHT;
    if (line.kind) {
      ctx.font = KIND_FONT;
      ctx.fillStyle = line.kind === '复习' ? group.color : '#68738b';
      ctx.fillText(line.kind, CONTENT_X, baseline);
    }
    let cursorX = TITLE_X;
    line.parts.forEach((part, partIndex) => {
      if (partIndex > 0) cursorX += 7;
      ctx.font = part.font;
      ctx.fillStyle = part.color;
      ctx.fillText(part.text, cursorX, baseline);
      cursorX += ctx.measureText(part.text).width;
    });
  });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png');
  });
}

export async function buildPracticeReportImageDownload(
  date: string,
  totalSeconds: number,
  groups: PracticeReportImageGroup[],
  formatDuration: (seconds: number) => string,
) {
  await document.fonts?.ready;
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  if (!measureContext) throw new Error('浏览器无法创建图片');
  const pages = paginate(measureContext, groups);
  const blobs: Blob[] = [];

  for (const rows of pages) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(WIDTH * OUTPUT_SCALE);
    canvas.height = Math.round(HEIGHT * OUTPUT_SCALE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器无法创建图片');
    ctx.scale(OUTPUT_SCALE, OUTPUT_SCALE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawHeader(ctx, date, totalSeconds, formatDuration);
    rows.forEach((row, index) => drawRow(ctx, row, formatDuration, index === 0));
    blobs.push(await canvasBlob(canvas));
  }

  const baseName = `PTE-练习日报-${date}-竖屏`;
  if (blobs.length === 1) return { blob: blobs[0], filename: `${baseName}.png`, pageCount: 1 };
  const { zipSync } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < blobs.length; index += 1) {
    files[`${baseName}-${String(index + 1).padStart(2, '0')}.png`] = new Uint8Array(await blobs[index].arrayBuffer());
  }
  const archive = zipSync(files, { level: 0 });
  return { blob: new Blob([archive], { type: 'application/zip' }), filename: `${baseName}-${blobs.length}张.zip`, pageCount: blobs.length };
}
