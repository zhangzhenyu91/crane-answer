const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const config = require('./config');

let cache = null;

function storeFile() {
  return path.join(config.dataDir, 'lines.json');
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = storeFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function initLines() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = storeFile();
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = {
      version: 1,
      updatedAt: loaded.updatedAt || null,
      lines: Array.isArray(loaded.lines) ? loaded.lines : [],
    };
    return;
  }
  cache = { version: 1, updatedAt: null, lines: [] };
  persist();
}

function getLines() {
  if (!cache) throw new Error('线路表尚未初始化');
  return cache.lines;
}

function getUpdatedAt() {
  return cache ? cache.updatedAt : null;
}

function normalizeVoltage(value) {
  const m = String(value == null ? '' : value).match(/\d+/);
  return m ? m[0] : '';
}

function normalizeLineEntry(item) {
  return {
    voltage: normalizeVoltage(item && item.voltage),
    name: String((item && item.name) || '').trim(),
    team: String((item && item.team) || '').trim(),
  };
}

function replaceLines(list) {
  const lines = (Array.isArray(list) ? list : []).map(normalizeLineEntry).filter((item) => item.name);
  if (!lines.length) {
    const err = new Error('线路表为空');
    err.status = 400;
    throw err;
  }
  if (lines.length > 2000) {
    const err = new Error('线路表最多 2000 行');
    err.status = 400;
    throw err;
  }
  cache.lines = lines;
  cache.updatedAt = new Date().toISOString();
  persist();
  return lines;
}

/**
 * 解析上传的线路一览表 xlsx：按表头「电压等级（kV）/ 线路名称 / 运行班组」定位列。
 */
async function parseLinesXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const err = new Error('xlsx 中没有工作表');
    err.status = 400;
    throw err;
  }
  const headerRow = sheet.getRow(1);
  const colMap = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = String(cell.value || '').trim();
    if (text.includes('电压等级')) colMap.voltage = colNumber;
    else if (text.includes('线路名称')) colMap.name = colNumber;
    else if (text.includes('运行班组')) colMap.team = colNumber;
  });
  if (!colMap.name) {
    const err = new Error('未找到「线路名称」列，请确认上传的是线路一览表');
    err.status = 400;
    throw err;
  }
  const lines = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = String((colMap.name && row.getCell(colMap.name).value) || '').trim();
    if (!name) return;
    lines.push({
      voltage: normalizeVoltage(colMap.voltage ? row.getCell(colMap.voltage).value : ''),
      name,
      team: String((colMap.team && row.getCell(colMap.team).value) || '').trim(),
    });
  });
  return lines;
}

const ROMAN_BY_DIGIT = { 1: 'Ⅰ', 2: 'Ⅱ', 3: 'Ⅲ' };

/**
 * 报送原文线路名归一化：
 * 去电压等级前缀（110kV）、去空白、阿拉伯/ASCII 罗马数字统一为 Ⅰ/Ⅱ/Ⅲ
 * （数字在「线」前或结尾均转换，兼容"吕汾1线"与"吕汾1"）。
 */
function normalizeRawName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^\d+\s*[kK][vV]\s*/, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/III(?=线|$)/g, 'Ⅲ').replace(/II(?=线|$)/g, 'Ⅱ').replace(/I(?=线|$)/g, 'Ⅰ');
  s = s.replace(/([123])(?=线|$)/g, (m, d) => ROMAN_BY_DIGIT[d]);
  return s;
}

/**
 * 线路名匹配：exact → 补「线」exact → 前缀候选。
 * @returns {{ status: 'ok', line: object } | { status: 'ambiguous', candidates: object[] } | { status: 'unmatched' }}
 */
function matchLine(raw) {
  const name = normalizeRawName(raw);
  const lines = getLines();
  if (!name) return { status: 'unmatched' };
  const exact = lines.find((item) => item.name === name);
  if (exact) return { status: 'ok', line: exact };
  if (!name.endsWith('线')) {
    const withSuffix = lines.find((item) => item.name === `${name}线`);
    if (withSuffix) return { status: 'ok', line: withSuffix };
  }
  const candidates = lines.filter((item) => item.name.startsWith(name) || name.startsWith(item.name));
  if (candidates.length === 1) return { status: 'ok', line: candidates[0] };
  if (candidates.length > 1) return { status: 'ambiguous', candidates };
  return { status: 'unmatched' };
}

module.exports = {
  initLines,
  getLines,
  getUpdatedAt,
  replaceLines,
  parseLinesXlsx,
  matchLine,
  normalizeRawName,
};
