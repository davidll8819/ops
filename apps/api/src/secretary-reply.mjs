import { z } from 'zod'
import { departments } from '../../../packages/secretary/model.mjs'
import { fail } from './db.mjs'

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  )

// Strip display-only metadata. Never infer missing business fields or repair their values.
const draftSchema = z.object({
  reply: z.string().trim().min(1).max(30000),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        dept: z.enum(departments.map((department) => department.id)),
        due: day,
        brief: z.string().trim().min(1).max(12000).optional(),
        dependsOn: z
          .array(z.number().int().nonnegative())
          .max(10)
          .nullish()
          .transform((value) => value || []),
        publishRequired: z.boolean().optional(),
        requiresConfirmation: z
          .boolean()
          .optional()
          .transform(() => true),
      }),
    )
    .max(10),
})

const protocolHint =
  /(?:["'“”](?:reply|tasks|dept|dependsOn|requiresConfirmation|publishRequired)["'“”]|\b(?:reply|tasks))\s*:|["'“”](?:reply|tasks)["'“”]?\s*$/
const has = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key)
const invalid = (reason) => fail(502, `秘书返回的任务格式不完整：${reason}`)

// This is deliberately not a general JSON repairer. Its only possible edit is inserting
// a backslash before an unescaped interior quote in one of three known text fields.
// It cannot insert delimiters, repair identifiers, coerce values, or invent missing text.
function repairTextQuotes(text) {
  let index = 0
  const insertions = [],
    repairs = []
  const stop = () => {
    throw invalid('任务 JSON 语法无效，无法仅修复文本引号')
  }
  const whitespace = () => {
    while (/\s/.test(text[index] || '') && index < text.length) index++
  }
  const expect = (char) => {
    whitespace()
    if (text[index++] !== char) stop()
  }
  const allowed = (path) =>
    (path.length === 1 && path[0] === 'reply') ||
    (path.length === 3 &&
      path[0] === 'tasks' &&
      Number.isInteger(path[1]) &&
      ['title', 'brief'].includes(path[2]))
  function string(path, key = false) {
    expect('"')
    const start = index - 1
    let count = 0
    while (index < text.length) {
      const char = text[index++]
      if (char === '\\') {
        index++
        continue
      }
      if (char !== '"') continue
      if (!key && allowed(path)) {
        const after = text.slice(index).match(/^\s*(.)/)?.[1]
        if (after && ![',', '}', ']'].includes(after)) {
          // A quote followed by another structural token could instead be a missing
          // delimiter/field boundary. Refuse to decide what the model meant.
          if (['"', ':', '{', '['].includes(after)) stop()
          insertions.push(index - 1)
          count++
          continue
        }
      }
      if (count)
        repairs.push({
          field: path.length === 1 ? path[0] : `tasks[${path[1]}].${path[2]}`,
          type: 'escape_unescaped_quote',
          count,
        })
      return key ? JSON.parse(text.slice(start, index)) : undefined
    }
    stop()
  }
  function value(path) {
    whitespace()
    if (text[index] === '"') {
      string(path)
      return
    }
    if (text[index] === '{') {
      index++
      whitespace()
      if (text[index] === '}') {
        index++
        return
      }
      const keys = new Set()
      for (;;) {
        const key = string([], true)
        if (keys.has(key)) throw invalid('任务 JSON 包含重复字段，无法确定应采用哪个值')
        keys.add(key)
        expect(':')
        value([...path, key])
        whitespace()
        if (text[index] === '}') {
          index++
          return
        }
        expect(',')
      }
    }
    if (text[index] === '[') {
      index++
      whitespace()
      if (text[index] === ']') {
        index++
        return
      }
      for (let item = 0; ; item++) {
        value([...path, item])
        whitespace()
        if (text[index] === ']') {
          index++
          return
        }
        expect(',')
      }
    }
    const match = text
      .slice(index)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    if (!match) stop()
    index += match[0].length
  }
  value([])
  whitespace()
  if (index !== text.length) stop()
  let repaired = '',
    previous = 0
  for (const insertion of insertions) {
    repaired += `${text.slice(previous, insertion)}\\`
    previous = insertion
  }
  repaired += text.slice(previous)
  return { value: JSON.parse(repaired), repairs }
}

// Read whole outermost JSON roots, never a convenient inner object from a wrapper or array.
// Brackets inside JSON strings are data; escaped quotes must not end those strings.
function roots(text) {
  const result = []
  let start = -1,
    stack = [],
    quoted = false,
    escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (start < 0) {
      if (char !== '{' && char !== '[') continue
      start = index
      stack = [char]
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (stack.at(-1) !== (char === '}' ? '{' : '[')) {
        result.push({ text: text.slice(start, index + 1), malformed: true })
        start = -1
        stack = []
        continue
      }
      stack.pop()
      if (!stack.length) {
        result.push({ text: text.slice(start, index + 1) })
        start = -1
      }
    }
  }
  if (start >= 0) result.push({ text: text.slice(start), incomplete: true })
  return result
}

function explain(issue) {
  const [root, index, field] = issue.path
  if (root === 'reply') return 'reply 必须是 1–30000 字符的回复文字'
  if (root !== 'tasks' || typeof index !== 'number') return 'tasks 必须是最多 10 项的任务数组'
  const prefix = `第 ${index + 1} 项任务`
  const reason = {
    title: 'title 必须是 1–120 字符的任务名',
    dept: 'dept 不是已接入的部门 ID',
    due: 'due 必须是有效的 YYYY-MM-DD 日期',
    brief: 'brief 必须是 1–12000 字符的完整要求',
    dependsOn: 'dependsOn 必须是最多 10 个非负整数下标',
    publishRequired: 'publishRequired 必须是布尔值',
    requiresConfirmation: 'requiresConfirmation 必须是布尔值',
  }[field]
  return `${prefix}的${reason || '内容必须是任务对象'}`
}

function validateDependencies(tasks) {
  tasks.forEach((task, index) => {
    for (const dependency of task.dependsOn) {
      if (dependency >= tasks.length) throw invalid(`第 ${index + 1} 项任务依赖了不存在的任务下标`)
      if (dependency === index) throw invalid(`第 ${index + 1} 项任务不能依赖自身`)
    }
  })
  const visiting = new Set(),
    visited = new Set()
  function visit(index) {
    if (visiting.has(index)) throw invalid('任务依赖不能形成循环')
    if (visited.has(index)) return
    visiting.add(index)
    tasks[index].dependsOn.forEach(visit)
    visiting.delete(index)
    visited.add(index)
  }
  tasks.forEach((_, index) => visit(index))
}

/** Parse one secretary reply without additional model calls or guessed task data. */
export function parseSecretaryReply(text, { finishReason } = {}) {
  if (['length', 'max_tokens', 'max_output_tokens'].includes(finishReason))
    throw invalid('模型输出已被截断，任务清单尚未完整返回')
  if (typeof text !== 'string' || !text.trim()) throw invalid('模型没有返回有效回复')
  if (text.length > 256000) throw invalid('模型回复超过允许长度')
  const clean = text.trim(),
    candidates = []
  let suspicious = false
  for (const root of roots(clean)) {
    const hinted = protocolHint.test(root.text)
    suspicious ||= hinted
    if (root.incomplete || root.malformed) {
      if (hinted)
        throw invalid(root.incomplete ? '任务 JSON 未闭合，可能已被截断' : '任务 JSON 括号不匹配')
      continue
    }
    let value,
      repairs = []
    try {
      value = JSON.parse(root.text)
    } catch {
      if (!hinted) continue
      try {
        ;({ value, repairs } = repairTextQuotes(root.text))
      } catch (error) {
        if (error.expose) throw error
        throw invalid('任务 JSON 语法无效')
      }
    }
    if (!Array.isArray(value) && has(value, 'reply') && has(value, 'tasks')) {
      // JSON.parse accepts duplicate object keys by keeping the last one. Re-scan a
      // valid plan too so two tasks/reply fields cannot silently override each other.
      if (!repairs.length) repairTextQuotes(root.text)
      candidates.push({ value, repairs })
    } else if (hinted) throw invalid('任务必须放在同一个最外层 reply 与 tasks 对象中，不接受嵌套清单')
  }
  if (candidates.length > 1) throw invalid('返回了多份任务清单，无法确定应派发哪一份')
  if (!candidates.length) {
    if (suspicious || protocolHint.test(clean))
      throw invalid('检测到任务字段，但没有完整的 reply 与 tasks 对象')
    return { reply: clean, tasks: [], repaired: false, repairs: [] }
  }
  const parsed = draftSchema.safeParse(candidates[0].value)
  if (!parsed.success) throw invalid(explain(parsed.error.issues[0]))
  validateDependencies(parsed.data.tasks)
  return {
    ...parsed.data,
    repaired: candidates[0].repairs.length > 0,
    repairs: candidates[0].repairs,
  }
}
