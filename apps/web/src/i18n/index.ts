import { useSyncExternalStore } from 'react'
import english from './en.json'
export type Language = 'zh' | 'en'
let language: Language =
  typeof localStorage !== 'undefined' && localStorage.getItem('office-language') === 'en'
    ? 'en'
    : 'zh'
const listeners = new Set<() => void>()
const dict: Record<string, string> = english
const reverse = Object.fromEntries(Object.entries(dict).map(([k, v]) => [v, k]))
export function t(message: string): string {
  if (language === 'en') {
    if (message.startsWith('等待前置任务完成：'))
      return `Waiting for prerequisites: ${message.slice('等待前置任务完成：'.length)}`
    if (message.startsWith('前置任务需要处理：'))
      return `Prerequisites need attention: ${message.slice('前置任务需要处理：'.length)}`
    return dict[message] ?? message
  }
  return (
    (
      {
        idle: '空闲',
        walking: '行走中',
        working: '工作中',
        talking: '交流中',
        thinking: '思考中',
      } as Record<string, string>
    )[message] ??
    reverse[message] ??
    message
  )
}
export function setLanguage(value: Language) {
  language = value
  localStorage.setItem('office-language', value)
  document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en'
  for (const fn of listeners) fn()
}
export function useLanguage() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => language,
  )
}
