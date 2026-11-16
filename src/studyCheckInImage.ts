export interface StudyCheckInRow {
  type: string;
  progress: string;
  seconds: number;
  color: string;
  softColor: string;
}

export interface StudyCheckInReport {
  date: string;
  totalSeconds: number;
  rows: StudyCheckInRow[];
}

export const CHECK_IN_WIDTH = 1080;
export const CHECK_IN_HEIGHT = 1440;
const ROWS_PER_PAGE = 8;
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';

function durationLabel(seconds: number) {
  const total = Math.floor(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours) return `${hours} 小时 ${pad(minutes)} 分 ${pad(remainder)} 秒`;
  if (minutes) return `${minutes} 分 ${pad(remainder)} 秒`;
  return `${remainder} 秒`;
}

function badgeInk(color: string) {
  const rgb = Number.parseInt(color.slice(1), 16);
  const channel = (shift: number) => Math.round(((rgb >> shift) & 255) * .76);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  const base = ctx.createLinearGradient(100, 0, 980, CHECK_IN_HEIGHT);
  base.addColorStop(0, '#f6f0fb');
  base.addColorStop(.5, '#f0f1fc');
  base.addColorStop(1, '#dfeef9');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, CHECK_IN_WIDTH, CHECK_IN_HEIGHT);

  const washes = [
    { x: 1000, y: 130, radius: 600, rgb: '221, 211, 246', opacity: .72 },
    { x: 0, y: 1400, radius: 540, rgb: '187, 220, 242', opacity: .64 },
  ];
  for (const { x, y, radius, rgb, opacity } of washes) {
    const wash = ctx.createRadialGradient(x, y, 0, x, y, radius);
    wash.addColorStop(0, `rgba(${rgb}, ${opacity})`);
    wash.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, CHECK_IN_WIDTH, CHECK_IN_HEIGHT);
  }

  ctx.lineWidth = 1.8;
  for (const { x, y, color } of [
    { x: 1140, y: -125, color: 'rgba(197, 182, 238, .55)' },
    { x: -158, y: 1610, color: 'rgba(168, 204, 233, .55)' },
  ]) {
    ctx.strokeStyle = color;
    for (let radius = 245; radius <= 535; radius += 36) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawCheckInPage(report: StudyCheckInReport, page: number, pageCount: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CHECK_IN_WIDTH;
  canvas.height = CHECK_IN_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法绘制打卡图');
  drawBackground(ctx);

  const ink = '#262d3d';
  const muted = '#59637e';
  const text = (value: string, x: number, y: number, size: number, color = ink, align: CanvasTextAlign = 'left', maxWidth = 944) => {
    ctx.fillStyle = color;
    ctx.font = `400 ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(value, x, y, maxWidth);
  };
  const box = (x: number, y: number, width: number, height: number, radius: number, fill: string, border?: string) => {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    if (border) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = border;
      ctx.stroke();
    }
  };

  text('PTE 学习打卡', 68, 127, 58);
  text(report.date.replaceAll('-', '.'), 1012, 131, 44, muted, 'right');

  box(68, 219, 944, 240, 34, '#faf8ff', '#e1d9f2');
  text('今日总用时', 110, 283, 32, '#57518e');
  text(durationLabel(report.totalSeconds), 106, 368, 66, '#403b65', 'left', 868);

  const rows = report.rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
  const cardTop = 511;
  const rowStart = cardTop + 111;
  const rowHeight = report.rows.length > 6 ? 86 : 112;
  box(68, cardTop, 944, 111 + rowHeight * Math.max(1, rows.length) + 21, 34, '#fff', '#e1e4f2');
  text('今日学习', 110, cardTop + 58, 42);

  if (!rows.length) text('暂无学习记录', 110, rowStart + rowHeight / 2, 32, muted);
  rows.forEach((row, index) => {
    const y = rowStart + index * rowHeight;
    const center = y + rowHeight / 2;
    ctx.fillStyle = '#eceef5';
    ctx.fillRect(108, y, 862, 1.5);
    const pillWidth = row.type.length <= 3 ? 95 : 155;
    box(110, center - 24, pillWidth, 48, 24, row.softColor);
    text(row.type, 110 + pillWidth / 2, center, 28, badgeInk(row.color), 'center', pillWidth - 18);
    text(row.progress || '—', 372, center, 32, ink, 'left', 328);
    text(row.seconds ? durationLabel(row.seconds) : '—', 967, center, 30, muted, 'right', 255);
  });

  if (pageCount > 1) text(`${page + 1} / ${pageCount}`, 1012, 1377, 28, muted, 'right');
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法导出 PNG')), 'image/png');
  });
}

export async function renderStudyCheckIn(report: StudyCheckInReport) {
  await document.fonts.ready;
  const pageCount = Math.max(1, Math.ceil(report.rows.length / ROWS_PER_PAGE));
  return Promise.all(Array.from({ length: pageCount }, (_, page) => drawCheckInPage(report, page, pageCount)));
}
