import { extractDocument } from './extract.mjs'
const send = (message) =>
  new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Parser parent disconnected'))
    process.send(message, (error) => (error ? reject(error) : resolve()))
  })
process.once('disconnect', () => process.exit(1))
process.once('message', async (input) => {
  try {
    const result = await extractDocument({
      name: input.name,
      bytes: Buffer.from(input.bytes),
      onProgress: (progress) => send({ type: 'progress', progress }),
    })
    await send({ type: 'result', result })
  } catch (error) {
    await send({
      type: 'error',
      error: {
        code: error.code || 'PARSE_FAILED',
        message:
          error.expose || error.code
            ? String(error.message).slice(0, 500)
            : '文档解析失败，请检查格式或重新导出文件',
      },
    }).catch(() => {})
  } finally {
    process.disconnect?.()
  }
})
