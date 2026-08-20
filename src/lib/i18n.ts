/**
 * Bilingual UI strings.
 *
 * Hand-rolled rather than using `chrome.i18n`, for a reason specific to this
 * extension: `chrome.i18n` resolves against the *browser* UI language and offers
 * no runtime switch, but the user asked to be able to choose the language in
 * settings. A dictionary keyed by an explicit locale setting is the only way to
 * honour that, and it has the side benefit of being type-checked — the
 * {@link Messages} type is closed, so a key added to English and forgotten in
 * Chinese is a compile error, not a string that silently renders as `undefined`
 * for half the users.
 *
 * Interpolation is deliberately primitive (`{name}` substitution) because the UI
 * needs no plural rules or gendered forms; adding an ICU formatter would be
 * weight without benefit.
 *
 * @module lib/i18n
 */

import type { LocaleSetting } from './types'

/** The resolved locale, after `auto` has been decided. */
export type Locale = 'en' | 'zh-CN'

/**
 * The complete message set.
 *
 * Closed on purpose: every locale must supply every key, so a missing
 * translation fails the build rather than reaching a user.
 */
export interface Messages {
  // Shell
  appName: string
  tagline: string

  // Capture bar
  capturing: string
  paused: string
  resume: string
  pause: string
  clearAll: string
  clearAllConfirm: string
  streamCount: string

  // Stream list
  noStreams: string
  noStreamsHint: string
  waitingForStreams: string
  filteredOut: string

  // Availability
  unavailableRestricted: string
  unavailableRestrictedHint: string
  unavailableNoTab: string
  unavailableDisabled: string
  unavailableDisabledHint: string
  reloadHint: string

  // Stream states
  stateOpen: string
  stateClosed: string
  stateError: string
  stateAborted: string

  // Detail tabs
  tabEvents: string
  tabMerged: string
  tabRaw: string
  tabRequest: string

  // Detail content
  events: string
  bytes: string
  duration: string
  timeToFirstByte: string
  droppedEvents: string
  droppedEventsHint: string
  truncated: string
  truncatedHint: string
  tailPending: string
  tailPendingHint: string
  unreadable: string
  eventSourceCaveat: string

  // Event view
  eventType: string
  eventId: string
  eventRetry: string
  eventComment: string
  eventData: string
  copyEvent: string
  expandAll: string
  collapseAll: string
  /** Explains that bulk expand only reaches the currently mounted frames. */
  bulkScope: string
  showJson: string
  showText: string
  olderEventsHidden: string
  newerEventsHidden: string

  // Merged view
  mergedEmpty: string
  mergedEmptyHint: string
  mergedFrom: string
  copyMerged: string

  // Raw view
  rawEmpty: string
  rawTruncatedHead: string

  // Request view
  requestHeaders: string
  responseHeaders: string
  requestBody: string
  noRequestBody: string
  noHeaders: string
  redactedNote: string
  copyAsCurl: string
  openUrl: string

  // Export
  exportJson: string
  exportNdjson: string
  copied: string
  copyFailed: string

  // Settings
  settings: string
  settingsCapture: string
  settingsCaptureMode: string
  settingsCaptureModeStrict: string
  settingsCaptureModeStrictHint: string
  settingsCaptureModeLoose: string
  settingsCaptureModeLooseHint: string
  settingsUrlFilter: string
  settingsUrlFilterHint: string
  settingsUrlFilterPlaceholder: string
  settingsKeepAcrossNavigation: string
  settingsKeepAcrossNavigationHint: string
  settingsAutoMergeDeltas: string
  settingsAutoMergeDeltasHint: string
  settingsLimits: string
  settingsMaxEventsPerStream: string
  settingsMaxEventBytes: string
  settingsMaxStreamsPerTab: string
  settingsMaxTabBytes: string
  settingsPrivacy: string
  settingsRedactHeaders: string
  settingsRedactHeadersHint: string
  settingsRedactHeadersPlaceholder: string
  settingsAlwaysRedacted: string
  settingsPrivacyNote: string
  settingsLanguage: string
  settingsLanguageAuto: string
  settingsReset: string
  settingsResetConfirm: string
  settingsSaved: string

  // Units
  unitBytes: string
  unitKb: string
  unitMb: string
  unitMs: string
  unitSeconds: string
}

const en: Messages = {
  appName: 'SSE Lens',
  tagline: 'Readable server-sent events for the current tab',

  capturing: 'Capturing',
  paused: 'Paused',
  resume: 'Resume',
  pause: 'Pause',
  clearAll: 'Clear',
  clearAllConfirm: 'Clear all captured streams?',
  streamCount: '{count} streams',

  noStreams: 'No streams captured yet',
  noStreamsHint:
    'Trigger a streaming request on this page. If the page was already loaded, reload it so the hook can attach before the page starts.',
  waitingForStreams: 'Waiting for a stream…',
  filteredOut: 'Some requests were skipped by the URL filter.',

  unavailableRestricted: 'This page cannot be inspected',
  unavailableRestrictedHint:
    'Chrome forbids extensions from running on its own pages, the Web Store, and other extensions. Open a normal http(s) page.',
  unavailableNoTab: 'No page selected',
  unavailableDisabled: 'Capture is switched off',
  unavailableDisabledHint: 'Turn capture back on to record streams.',
  reloadHint: 'Reload the page',

  stateOpen: 'open',
  stateClosed: 'closed',
  stateError: 'error',
  stateAborted: 'aborted',

  tabEvents: 'Events',
  tabMerged: 'Merged',
  tabRaw: 'Raw',
  tabRequest: 'Request',

  events: 'events',
  bytes: 'bytes',
  duration: 'Duration',
  timeToFirstByte: 'First byte',
  droppedEvents: '{count} older events dropped',
  droppedEventsHint:
    'The per-stream limit was reached. Raise it in settings if you need a longer history.',
  truncated: 'truncated',
  truncatedHint: 'This payload exceeded the per-event size limit and was cut short.',
  tailPending: 'Unterminated trailing data',
  tailPendingHint:
    'The stream ended in the middle of an event. This is shown as-is because it usually indicates a server-side problem.',
  unreadable: 'Body not readable: {reason}',
  eventSourceCaveat:
    'Captured through EventSource, so comments and exact framing are not available — the browser had already parsed them.',

  eventType: 'type',
  eventId: 'id',
  eventRetry: 'retry',
  eventComment: 'comment',
  eventData: 'data',
  copyEvent: 'Copy event',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  bulkScope: 'Expand and collapse apply to the {shown} loaded events, of {total} captured.',
  showJson: 'JSON',
  showText: 'Text',
  olderEventsHidden: 'Show {count} earlier events',
  newerEventsHidden: 'Show {count} later events',

  mergedEmpty: 'Nothing to merge',
  mergedEmptyHint:
    'Merging looks for incremental text fields such as choices[].delta.content. This stream has none.',
  mergedFrom: 'Merged from {path}',
  copyMerged: 'Copy text',

  rawEmpty: 'No raw text captured',
  rawTruncatedHead: 'Earlier text was dropped to stay within the size limit.',

  requestHeaders: 'Request headers',
  responseHeaders: 'Response headers',
  requestBody: 'Request body',
  noRequestBody: 'No body, or a body type that cannot be read without consuming it.',
  noHeaders: 'None recorded',
  redactedNote: 'Sensitive values are masked before leaving the page.',
  copyAsCurl: 'Copy as curl',
  openUrl: 'Open URL',

  exportJson: 'Export JSON',
  exportNdjson: 'Export NDJSON',
  copied: 'Copied',
  copyFailed: 'Copy failed',

  settings: 'Settings',
  settingsCapture: 'Capture',
  settingsCaptureMode: 'What to capture',
  settingsCaptureModeStrict: 'Strict',
  settingsCaptureModeStrictHint: 'Only text/event-stream responses.',
  settingsCaptureModeLoose: 'Loose',
  settingsCaptureModeLooseHint:
    'Also text/plain, NDJSON and unlabelled responses, when the payload looks framed. Catches proxies that mislabel SSE.',
  settingsUrlFilter: 'URL filter',
  settingsUrlFilterHint: 'Substring, or /regex/flags. Empty captures everything.',
  settingsUrlFilterPlaceholder: '/v1/chat or /\\/stream$/',
  settingsKeepAcrossNavigation: 'Keep streams across navigation',
  settingsKeepAcrossNavigationHint:
    'Off by default, because a list from a page that is gone is misleading.',
  settingsAutoMergeDeltas: 'Merge delta text automatically',
  settingsAutoMergeDeltasHint: 'Detects incremental fields and assembles the final text.',
  settingsLimits: 'Limits',
  settingsMaxEventsPerStream: 'Events kept per stream',
  settingsMaxEventBytes: 'Max size per event',
  settingsMaxStreamsPerTab: 'Streams kept per tab',
  settingsMaxTabBytes: 'Max total size per tab',
  settingsPrivacy: 'Privacy',
  settingsRedactHeaders: 'Extra headers to mask',
  settingsRedactHeadersHint: 'One per line. Case-insensitive.',
  settingsRedactHeadersPlaceholder: 'x-internal-token',
  settingsAlwaysRedacted: 'Always masked',
  settingsPrivacyNote:
    'Captures are held in session storage only and are cleared when the browser closes. They are never written to disk.',
  settingsLanguage: 'Language',
  settingsLanguageAuto: 'Follow browser',
  settingsReset: 'Reset to defaults',
  settingsResetConfirm: 'Reset all settings?',
  settingsSaved: 'Saved',

  unitBytes: 'B',
  unitKb: 'KB',
  unitMb: 'MB',
  unitMs: 'ms',
  unitSeconds: 's',
}

const zhCN: Messages = {
  appName: 'SSE Lens',
  tagline: '把当前标签页的 SSE 流看清楚',

  capturing: '正在抓取',
  paused: '已暂停',
  resume: '继续',
  pause: '暂停',
  clearAll: '清空',
  clearAllConfirm: '确定清空已抓取的全部流？',
  streamCount: '{count} 条流',

  noStreams: '还没有抓到流',
  noStreamsHint:
    '在当前页面触发一次流式请求。如果页面在开启前就已加载，请刷新一次，让钩子在页面脚本之前装上。',
  waitingForStreams: '等待流数据…',
  filteredOut: '部分请求被 URL 过滤条件跳过了。',

  unavailableRestricted: '该页面无法检查',
  unavailableRestrictedHint:
    'Chrome 禁止扩展在浏览器内置页面、应用商店和其他扩展页面上运行。请切换到普通的 http(s) 页面。',
  unavailableNoTab: '未选中页面',
  unavailableDisabled: '抓取已关闭',
  unavailableDisabledHint: '重新开启抓取即可记录流。',
  reloadHint: '刷新页面',

  stateOpen: '进行中',
  stateClosed: '已结束',
  stateError: '出错',
  stateAborted: '已取消',

  tabEvents: '事件',
  tabMerged: '合并文本',
  tabRaw: '原始',
  tabRequest: '请求',

  events: '个事件',
  bytes: '字节',
  duration: '耗时',
  timeToFirstByte: '首字节',
  droppedEvents: '已丢弃 {count} 个较早事件',
  droppedEventsHint: '已达到单条流的事件上限。若需要更长历史，请在设置里调高。',
  truncated: '已截断',
  truncatedHint: '该负载超过单个事件的大小上限，已被截断。',
  tailPending: '结尾数据不完整',
  tailPendingHint: '流在一个事件中途结束。这里原样展示，因为它通常意味着服务端有问题。',
  unreadable: '响应体无法读取：{reason}',
  eventSourceCaveat:
    '这条流通过 EventSource 抓取，浏览器已完成解析，因此拿不到注释和精确分帧。',

  eventType: '类型',
  eventId: 'id',
  eventRetry: 'retry',
  eventComment: '注释',
  eventData: '数据',
  copyEvent: '复制事件',
  expandAll: '全部展开',
  collapseAll: '全部折叠',
  bulkScope: '展开/折叠作用于已加载的 {shown} 条事件（共抓取 {total} 条）。',
  showJson: 'JSON',
  showText: '文本',
  olderEventsHidden: '显示前 {count} 个事件',
  newerEventsHidden: '显示后 {count} 个事件',

  mergedEmpty: '没有可合并的内容',
  mergedEmptyHint: '合并会寻找 choices[].delta.content 这类增量文本字段，这条流里没有。',
  mergedFrom: '来自 {path}',
  copyMerged: '复制文本',

  rawEmpty: '没有抓到原始文本',
  rawTruncatedHead: '为控制体积，较早的文本已被丢弃。',

  requestHeaders: '请求头',
  responseHeaders: '响应头',
  requestBody: '请求体',
  noRequestBody: '没有请求体，或该类型的请求体读取后会破坏原请求。',
  noHeaders: '未记录',
  redactedNote: '敏感值在离开页面前已被遮蔽。',
  copyAsCurl: '复制为 curl',
  openUrl: '打开链接',

  exportJson: '导出 JSON',
  exportNdjson: '导出 NDJSON',
  copied: '已复制',
  copyFailed: '复制失败',

  settings: '设置',
  settingsCapture: '抓取',
  settingsCaptureMode: '抓取范围',
  settingsCaptureModeStrict: '严格',
  settingsCaptureModeStrictHint: '仅 text/event-stream 响应。',
  settingsCaptureModeLoose: '宽松',
  settingsCaptureModeLooseHint:
    '当负载看起来有分帧时，也抓取 text/plain、NDJSON 和未标注类型的响应。可以覆盖那些标错类型的代理。',
  settingsUrlFilter: 'URL 过滤',
  settingsUrlFilterHint: '子串，或 /正则/标志。留空表示全部抓取。',
  settingsUrlFilterPlaceholder: '/v1/chat 或 /\\/stream$/',
  settingsKeepAcrossNavigation: '跳转后保留已抓取的流',
  settingsKeepAcrossNavigationHint: '默认关闭：页面已经不在了，还留着它的列表容易看错。',
  settingsAutoMergeDeltas: '自动合并增量文本',
  settingsAutoMergeDeltasHint: '识别增量字段并拼出最终文本。',
  settingsLimits: '上限',
  settingsMaxEventsPerStream: '每条流保留的事件数',
  settingsMaxEventBytes: '单个事件最大体积',
  settingsMaxStreamsPerTab: '每个标签页保留的流数',
  settingsMaxTabBytes: '每个标签页的总体积上限',
  settingsPrivacy: '隐私',
  settingsRedactHeaders: '额外需要遮蔽的请求头',
  settingsRedactHeadersHint: '每行一个，不区分大小写。',
  settingsRedactHeadersPlaceholder: 'x-internal-token',
  settingsAlwaysRedacted: '始终遮蔽',
  settingsPrivacyNote:
    '抓取结果只保存在会话存储中，浏览器关闭即清除，不会写入磁盘。',
  settingsLanguage: '语言',
  settingsLanguageAuto: '跟随浏览器',
  settingsReset: '恢复默认',
  settingsResetConfirm: '确定恢复全部默认设置？',
  settingsSaved: '已保存',

  unitBytes: 'B',
  unitKb: 'KB',
  unitMb: 'MB',
  unitMs: '毫秒',
  unitSeconds: '秒',
}

const DICTIONARIES: Record<Locale, Messages> = { en, 'zh-CN': zhCN }

/**
 * Resolves the `auto` setting against the browser's languages.
 *
 * Any `zh` variant maps to Simplified Chinese: someone whose browser is set to
 * `zh-TW` is far better served by Chinese text than by English, and maintaining a
 * separate Traditional dictionary is not justified for a developer tool of this
 * size.
 */
export function resolveLocale(setting: LocaleSetting, languages: readonly string[] = []): Locale {
  if (setting === 'en' || setting === 'zh-CN') return setting
  for (const language of languages) {
    const lower = language.toLowerCase()
    if (lower.startsWith('zh')) return 'zh-CN'
    if (lower.startsWith('en')) return 'en'
  }
  return 'en'
}

/** Reads the browser's language preferences, in order. */
export function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  const languages = navigator.languages
  if (Array.isArray(languages) && languages.length > 0) return [...languages]
  return navigator.language ? [navigator.language] : []
}

export type Translate = (key: keyof Messages, params?: Record<string, string | number>) => string

/**
 * Builds a translator for a locale.
 *
 * An unknown `{placeholder}` is left verbatim rather than blanked, because a
 * visible `{count}` in the UI is a bug report; an empty space is a mystery.
 */
export function createTranslate(locale: Locale): Translate {
  const dictionary = DICTIONARIES[locale]
  return (key, params) => {
    const template = dictionary[key]
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name]
      return value === undefined ? match : String(value)
    })
  }
}

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale]
}
