const { buildSessionWorkbook, exportFileName } = require('./export');
const { sendFile } = require('../wechatpadpro/sender');
const store = require('./store');

/**
 * 生成会话汇总 xlsx 并发送至该会话所属群聊，成功后记录 sentAt。
 * @returns {Promise<{ fileName: string, bytes: number }>}
 */
async function sendSessionXlsx(session) {
  const workbook = await buildSessionWorkbook(session);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = exportFileName(session);
  await sendFile(session.groupId, buffer, fileName);
  store.markSessionSent(session.id);
  return { fileName, bytes: buffer.length };
}

module.exports = { sendSessionXlsx };
