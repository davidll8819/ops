import { fork } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fail } from '../db.mjs'
// Shared across app instances. Release capacity only after the OS process exits.
let active = 0
export function validProgress(value) {
  return (
    value &&
    ['extracting', 'ocr'].includes(value.stage) &&
    Number.isInteger(value.page) &&
    Number.isInteger(value.totalPages) &&
    value.page >= 1 &&
    value.page <= value.totalPages &&
    value.totalPages <= 120 &&
    Object.keys(value).every((key) => ['stage', 'page', 'totalPages'].includes(key))
  )
}
function validResult(result) {
  return (
    result &&
    ['docx', 'pdf', 'xlsx', 'image'].includes(result.kind) &&
    Array.isArray(result.blocks) &&
    result.blocks.length > 0 &&
    result.blocks.length <= 2000 &&
    result.blocks.every(
      (b) =>
        b &&
        typeof b.id === 'string' &&
        b.id.length <= 100 &&
        typeof b.location === 'string' &&
        b.location.length <= 500 &&
        typeof b.text === 'string' &&
        Array.from(b.text).length <= 2000 &&
        (b.method === undefined ||
          (b.method === 'ocr' && Number.isInteger(b.page) && b.page >= 1 && b.page <= 120)),
    ) &&
    result.blocks.reduce((n, b) => n + Array.from(b.text).length, 0) <= 200000 &&
    Array.isArray(result.warnings) &&
    result.warnings.length <= 500 &&
    result.warnings.every((w) => typeof w === 'string' && w.length <= 2000) &&
    result.stats &&
    typeof result.stats === 'object' &&
    JSON.stringify(result).length <= 2000000
  )
}
export function createDocumentParser({ timeoutMs = 30000, ocrTimeoutMs = 300000 } = {}) {
  const owned = new Set(),
    pending = new Set()
  let closed = false
  const parse = (input, { onProgress } = {}) => {
    if (closed) return Promise.reject(fail(503, '文档解析器已关闭，请稍后重试'))
    if (active >= 2) return Promise.reject(fail(429, '当前文档解析繁忙，请稍后重试'))
    active++
    const run = (async () => {
      let child, timer, exited, stop, temporary, temporaryRoot
      try {
        const ocr = /\.(pdf|png|jpe?g|webp)$/i.test(input.name)
        temporaryRoot = realpathSync(tmpdir())
        temporary = mkdtempSync(join(temporaryRoot, 'archive-ocr-parser-'))
        return await new Promise((resolve, reject) => {
          let settled = false,
            resultReceived = false,
            progress = Promise.resolve(),
            messages = 0
          const finish = (error, result) => {
            if (settled) return
            if (error) {
              // Cancellation/deadlines must not wait for a blocked callback.
              settled = true
              reject(error)
              return
            }
            if (resultReceived) return
            resultReceived = true
            // A received result remains cancellable until every progress write
            // finishes. Rejections are consumed even after cancellation.
            progress.then(
              () => {
                if (settled) return
                settled = true
                resolve(result)
              },
              (error) => finish(error),
            )
          }
          stop = () => {
            child?.kill('SIGKILL')
            finish(fail(503, '文档解析器已关闭，请稍后重试'))
          }
          const env = { ARCHIVE_OCR_TMPDIR: temporary }
          for (const key of [
            'PATH',
            'Path',
            'SystemRoot',
            'SYSTEMROOT',
            'WINDIR',
            'TEMP',
            'TMP',
            'USERPROFILE',
            'NODE_ENV',
          ]) {
            if (process.env[key] !== undefined) env[key] = process.env[key]
          }
          child = fork(new URL('./parse-worker.mjs', import.meta.url), [], {
            serialization: 'advanced',
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            execArgv: ['--max-old-space-size=256'],
            env,
          })
          owned.add(stop)
          exited = new Promise((resolveExit) => child.once('close', resolveExit))
          child.on('message', (message) => {
            if (settled || resultReceived) return
            if (!message || typeof message !== 'object')
              return finish(fail(400, '文档解析进程返回无效结果'))
            if (message.type === 'progress') {
              if (++messages > 260 || !validProgress(message.progress))
                return finish(fail(400, '文档解析进度无效，请重试'))
              const value = {
                stage: message.progress.stage,
                page: message.progress.page,
                totalPages: message.progress.totalPages,
              }
              progress = progress.then(() => {
                if (!settled) return onProgress?.(value)
              })
              progress.catch((error) => finish(error))
            } else if (message.type === 'result') {
              if (!validResult(message.result))
                return finish(fail(400, '文档解析结果超出限制或无效，请拆分文件后重试'))
              finish(null, message.result)
            } else if (message.type === 'error') {
              const error = message.error
              finish(
                Object.assign(
                  fail(
                    400,
                    typeof error?.message === 'string'
                      ? error.message.slice(0, 500)
                      : '文档解析失败，请重新导出文件',
                  ),
                  {
                    code:
                      typeof error?.code === 'string' ? error.code.slice(0, 100) : 'PARSE_FAILED',
                  },
                ),
              )
            } else finish(fail(400, '文档解析进程返回无效结果'))
          })
          child.once('error', () => finish(fail(400, '文档解析进程中断，请重新导出后重试')))
          child.once('exit', () => {
            if (!resultReceived) finish(fail(400, '文档解析进程已退出，请重试'))
          })
          timer = setTimeout(
            () => finish(fail(408, `文档解析超过${ocr ? '300' : '30'}秒，请拆分文件后重试`)),
            ocr ? ocrTimeoutMs : timeoutMs,
          )
          child.send({ name: input.name, bytes: Buffer.from(input.bytes) }, (error) => {
            if (error) finish(fail(400, '无法发送文档至解析进程，请重试'))
          })
        })
      } finally {
        clearTimeout(timer)
        owned.delete(stop)
        if (child) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          await exited
        }
        try {
          // This is the exact fresh directory created above, never a caller-provided path.
          if (temporary) {
            if (
              dirname(temporary) !== temporaryRoot ||
              !basename(temporary).startsWith('archive-ocr-parser-')
            )
              throw new Error('Unsafe parser cleanup path')
            await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
          }
        } finally {
          active--
        }
      }
    })()
    pending.add(run)
    run.then(
      () => pending.delete(run),
      () => pending.delete(run),
    )
    return run
  }
  parse.close = async () => {
    closed = true
    for (const stop of owned) stop()
    await Promise.allSettled([...pending])
  }
  return parse
}
