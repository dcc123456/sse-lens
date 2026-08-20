/**
 * The settings tab.
 *
 * Every control carries a hint explaining *why* it exists, not just what it does.
 * That is a deliberate cost: these settings trade fidelity against memory, and a
 * user who cannot tell which way a slider moves that trade will either leave the
 * defaults forever or set something that quietly loses their data.
 *
 * Changes apply immediately rather than behind a Save button. There is no
 * multi-field invariant to hold, the worker validates and clamps every value
 * anyway, and a debugging tool should not make someone confirm that they meant to
 * change a limit.
 *
 * @module panel/SettingsTab
 */

import type { ReactNode } from 'react'
import { Badge, ConfirmButton, Notice } from './components'
import { ALWAYS_REDACTED_HEADERS } from '../lib/redact'
import { DEFAULT_SETTINGS, type CaptureMode, type LocaleSetting, type Settings } from '../lib/types'
import type { Translate } from '../lib/i18n'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {hint !== undefined && <div className="field-hint">{hint}</div>}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}): ReactNode {
  return (
    <div className="field">
      <label className="field-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="field-row-text">
          <span className="field-label" style={{ marginBottom: 0 }}>
            {label}
          </span>
          {hint !== undefined && <span className="field-hint">{hint}</span>}
        </span>
      </label>
    </div>
  )
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}): ReactNode {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          // An empty or half-typed field parses as NaN; ignoring it lets the user
          // keep typing instead of having the value snap to a bound mid-edit.
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
      />
    </Field>
  )
}

export function SettingsTab({
  settings,
  onChange,
  t,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  t: Translate
}): ReactNode {
  const modes: { value: CaptureMode; label: string; hint: string }[] = [
    {
      value: 'strict',
      label: t('settingsCaptureModeStrict'),
      hint: t('settingsCaptureModeStrictHint'),
    },
    {
      value: 'loose',
      label: t('settingsCaptureModeLoose'),
      hint: t('settingsCaptureModeLooseHint'),
    },
  ]

  return (
    <div className="settings">
      <div className="settings-group">
        <div className="settings-group-title">{t('settingsCapture')}</div>

        <Field label={t('settingsCaptureMode')}>
          {modes.map((mode) => (
            <label
              key={mode.value}
              className={
                settings.captureMode === mode.value ? 'radio-option selected' : 'radio-option'
              }
            >
              <input
                type="radio"
                name="captureMode"
                checked={settings.captureMode === mode.value}
                onChange={() => onChange({ captureMode: mode.value })}
              />
              <span className="field-row-text">
                <span className="field-label" style={{ marginBottom: 0 }}>
                  {mode.label}
                </span>
                <span className="field-hint">{mode.hint}</span>
              </span>
            </label>
          ))}
        </Field>

        <Field label={t('settingsUrlFilter')} hint={t('settingsUrlFilterHint')}>
          <input
            type="text"
            value={settings.urlFilter}
            placeholder={t('settingsUrlFilterPlaceholder')}
            onChange={(event) => onChange({ urlFilter: event.target.value })}
          />
        </Field>

        <Toggle
          label={t('settingsKeepAcrossNavigation')}
          hint={t('settingsKeepAcrossNavigationHint')}
          checked={settings.keepAcrossNavigation}
          onChange={(value) => onChange({ keepAcrossNavigation: value })}
        />

        <Toggle
          label={t('settingsAutoMergeDeltas')}
          hint={t('settingsAutoMergeDeltasHint')}
          checked={settings.autoMergeDeltas}
          onChange={(value) => onChange({ autoMergeDeltas: value })}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">{t('settingsLimits')}</div>

        <NumberField
          label={t('settingsMaxEventsPerStream')}
          value={settings.maxEventsPerStream}
          min={10}
          max={100000}
          step={100}
          onChange={(value) => onChange({ maxEventsPerStream: value })}
        />
        <NumberField
          label={`${t('settingsMaxEventBytes')} (${t('unitBytes')})`}
          value={settings.maxEventBytes}
          min={256}
          max={4 * 1024 * 1024}
          step={1024}
          onChange={(value) => onChange({ maxEventBytes: value })}
        />
        <NumberField
          label={t('settingsMaxStreamsPerTab')}
          value={settings.maxStreamsPerTab}
          min={1}
          max={500}
          onChange={(value) => onChange({ maxStreamsPerTab: value })}
        />
        <NumberField
          label={`${t('settingsMaxTabBytes')} (${t('unitBytes')})`}
          value={settings.maxTabBytes}
          min={64 * 1024}
          max={64 * 1024 * 1024}
          step={1024 * 1024}
          onChange={(value) => onChange({ maxTabBytes: value })}
        />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">{t('settingsPrivacy')}</div>

        <Notice tone="info">{t('settingsPrivacyNote')}</Notice>

        <Field label={t('settingsRedactHeaders')} hint={t('settingsRedactHeadersHint')}>
          <textarea
            value={settings.redactHeaders.join('\n')}
            placeholder={t('settingsRedactHeadersPlaceholder')}
            onChange={(event) =>
              onChange({
                redactHeaders: event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== ''),
              })
            }
          />
        </Field>

        <div className="field">
          <span className="field-label">{t('settingsAlwaysRedacted')}</span>
          <div className="masked-list">
            {ALWAYS_REDACTED_HEADERS.map((name) => (
              <Badge key={name}>{name}</Badge>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">{t('settingsLanguage')}</div>
        <Field label={t('settingsLanguage')}>
          <select
            value={settings.locale}
            onChange={(event) => onChange({ locale: event.target.value as LocaleSetting })}
          >
            <option value="auto">{t('settingsLanguageAuto')}</option>
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </Field>
      </div>

      <ConfirmButton
        label={t('settingsReset')}
        confirmLabel={t('settingsResetConfirm')}
        onConfirm={() => onChange({ ...DEFAULT_SETTINGS })}
      />
    </div>
  )
}
