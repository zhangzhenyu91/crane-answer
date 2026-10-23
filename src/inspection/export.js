const ExcelJS = require('exceljs');
const { getSettings } = require('../settings');
const { getLines } = require('../lines');

const HEADERS = [
  '序号',
  '电压等级',
  '线路名称',
  '区段',
  '树种',
  '数量',
  '距小号侧距离（m）',
  '距大号侧距离（m）',
  '直径（cm）',
  '水平距离（m）',
  '垂直距离（m）',
  '发现人',
  '发现时间',
];

function text(value) {
  return value == null ? '' : String(value);
}

function formatSection(record) {
  const ex = record.extracted || {};
  const from = Number(ex.pole_from);
  const to = Number(ex.pole_to);
  if (!Number.isFinite(from) || from <= 0) return '';
  const note = String(ex.position_note || '').trim();
  const suffix = note && note !== '塔底' ? note : '';
  if (!Number.isFinite(to) || to <= 0 || to === from) return `${from}#${suffix}`;
  return `${from}#-${to}#${suffix}`;
}

function formatVertical(record) {
  const ex = record.extracted || {};
  const overHeight = ex.over_height;
  if (overHeight !== undefined && overHeight !== null && String(overHeight).trim() !== '') {
    return `超高${String(overHeight).trim()}`;
  }
  return text(ex.vertical).trim();
}

function formatSideDistance(record, side) {
  const ex = record.extracted || {};
  const value = text(ex.distance).trim();
  if (!value) return '';
  const recordSide = String(ex.side || '').trim();
  if (side === 'small') return recordSide === 'small' || recordSide === 'both' ? value : '';
  return recordSide === 'big' ? value : '';
}

function formatFindDate(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function resolveFinderName(senderId, fallback) {
  const { aliases } = getSettings();
  const override = (aliases || []).find((item) => item.wxid === senderId);
  return override ? override.name : (fallback || senderId || '');
}

/**
 * 发现人展示名：记录者在前；存在协作供图人（coSenderId，引用他人图片报送/为他人记录补图）时
 * 拼接在后，单空格分隔（多人配合，上限两人）。alias 覆盖对两人各自生效。
 */
function resolveFinderNames(record) {
  const base = resolveFinderName(record.senderId, record.senderName);
  const coId = String((record && record.coSenderId) || '');
  if (!coId || coId === record.senderId) return base;
  const coName = resolveFinderName(coId, record.coSenderName);
  return coName ? `${base} ${coName}` : base;
}

function poleNumber(record) {
  const ex = record.extracted || {};
  const from = Number(ex.pole_from);
  return Number.isFinite(from) && from > 0 ? from : Number.MAX_SAFE_INTEGER;
}

/**
 * 汇总排序：按线路表顺序分组（未匹配的排最后），组内按起始杆号升序。
 */
function sortRecords(records) {
  const lines = getLines();
  const order = new Map(lines.map((line, index) => [line.name, index]));
  return [...records].sort((a, b) => {
    const lineA = a.matchedLine ? a.matchedLine.name : '';
    const lineB = b.matchedLine ? b.matchedLine.name : '';
    const orderA = order.has(lineA) ? order.get(lineA) : lines.length;
    const orderB = order.has(lineB) ? order.get(lineB) : lines.length;
    if (orderA !== orderB) return orderA - orderB;
    if (lineA !== lineB) return lineA.localeCompare(lineB, 'zh-CN');
    const poleDiff = poleNumber(a) - poleNumber(b);
    if (poleDiff !== 0) return poleDiff;
    return a.capturedAt - b.capturedAt;
  });
}

function buildRow(record, seq) {
  const ex = record.extracted || {};
  return [
    text(seq),
    record.matchedLine && record.matchedLine.voltage ? `${record.matchedLine.voltage}kV` : '',
    record.matchedLine ? record.matchedLine.name : (record.lineNameRaw ? `${record.lineNameRaw}（待确认）` : ''),
    formatSection(record),
    text(ex.tree_species).trim(),
    text(ex.tree_count).trim(),
    formatSideDistance(record, 'small'),
    formatSideDistance(record, 'big'),
    text(ex.diameter).trim(),
    text(ex.horizontal).trim(),
    formatVertical(record),
    resolveFinderNames(record),
    formatFindDate(record.capturedAt),
  ];
}

/**
 * 生成会话汇总 xlsx。全部单元格按字符串写入并锁定文本格式（numFmt '@'），
 * 禁止 Excel 自动转为日期或数字。
 */
async function buildSessionWorkbook(session) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('通道树木排查记录');
  sheet.columns = HEADERS.map((header, index) => ({
    header,
    key: `c${index}`,
    width: [6, 10, 14, 14, 10, 8, 16, 16, 10, 13, 13, 12, 13][index] || 12,
    style: { numFmt: '@' },
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).numFmt = '@';

  const records = sortRecords(session.records.filter((item) => item.status === 'active'));
  records.forEach((record, index) => {
    const row = sheet.addRow(buildRow(record, index + 1));
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.numFmt = '@';
      cell.value = cell.value == null ? '' : String(cell.value);
    });
  });
  return workbook;
}

function exportFileName(session) {
  const group = (session.groupName || session.groupId || '排查记录').replace(/[\\/:*?"<>|]/g, '_');
  return `通道树木排查记录_${group}_${formatFindDate(session.startedAt) || '未命名'}.xlsx`;
}

module.exports = {
  buildSessionWorkbook,
  exportFileName,
  HEADERS,
  formatSection,
  formatVertical,
  formatSideDistance,
  resolveFinderName,
  resolveFinderNames,
};
