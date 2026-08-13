import { useState } from 'react'
import { cx } from '@/lib/cx'
import type { EnergyLevel, Priority, Project, TaskTemplate, TemplateInsert } from '@/lib/types'
import { DAY_LABELS, PRIORITY_LABEL, toHHMM } from './lib'

const FIELD =
  'rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none'
const LABEL = 'font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase'

interface Props {
  /** null → creating a new template. */
  template: TaskTemplate | null
  projects: Project[]
  busy: boolean
  onSave: (input: TemplateInsert) => void
  onCancel: () => void
}

/** Inline expanding form card — one draft in local state, committed on save. */
export function TemplateEditor({ template, projects, busy, onSave, onCancel }: Props) {
  const [title, setTitle] = useState(template?.title ?? '')
  const [notes, setNotes] = useState(template?.notes ?? '')
  const [rule, setRule] = useState<TaskTemplate['repeat_rule']>(template?.repeat_rule ?? 'daily')
  const [days, setDays] = useState<number[]>(template?.custom_days ?? [])
  const [time, setTime] = useState(toHHMM(template?.due_time ?? null))
  const [estimate, setEstimate] = useState(
    template?.estimate_minutes ? String(template.estimate_minutes) : '',
  )
  const [priority, setPriority] = useState<Priority>(template?.priority ?? 0)
  const [energy, setEnergy] = useState<EnergyLevel | ''>(template?.energy ?? '')
  const [projectId, setProjectId] = useState(template?.project_id ?? '')

  // A custom rule with zero days would silently never generate — block saving.
  const invalid = !title.trim() || (rule === 'custom' && days.length === 0)

  function toggleDay(day: number) {
    setDays((cur) => (cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day]))
  }

  function handleSubmit() {
    if (invalid || busy) return
    onSave({
      title: title.trim(),
      notes: notes.trim() || null,
      repeat_rule: rule,
      custom_days: rule === 'custom' ? [...days].sort((a, b) => a - b) : null,
      due_time: time || null,
      estimate_minutes: estimate ? Number(estimate) : null,
      priority,
      energy: energy || null,
      project_id: projectId || null,
    })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        handleSubmit()
      }}
      className="grid gap-3 rounded-card border border-accent/40 bg-surface px-3 py-3 sm:grid-cols-2"
    >
      <label className="sm:col-span-2 flex flex-col gap-1">
        <span className={LABEL}>Название</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Например: планёрка"
          autoFocus
          className={FIELD}
        />
      </label>

      <label className="sm:col-span-2 flex flex-col gap-1">
        <span className={LABEL}>Заметки</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={cx(FIELD, 'resize-y')}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Повтор</span>
        <select
          value={rule}
          onChange={(e) => setRule(e.target.value as TaskTemplate['repeat_rule'])}
          className={FIELD}
        >
          <option value="daily">Каждый день</option>
          <option value="weekdays">По будням</option>
          <option value="custom">Выбранные дни</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Время</span>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={FIELD} />
      </label>

      {rule === 'custom' && (
        <fieldset className="sm:col-span-2 flex flex-col gap-1">
          <legend className={LABEL}>Дни недели</legend>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, i) => {
              const day = i + 1
              const selected = days.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleDay(day)}
                  className={cx(
                    'rounded-control border px-2.5 py-1 font-mono text-[0.7rem] transition-colors',
                    selected
                      ? 'border-accent bg-accent text-ground'
                      : 'border-rule text-muted hover:border-accent',
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </fieldset>
      )}

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Оценка, мин</span>
        <input
          type="number"
          min={1}
          max={1440}
          step={5}
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Приоритет</span>
        <select
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value) as Priority)}
          className={FIELD}
        >
          {([0, 1, 2, 3] as const).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Энергия</span>
        <select
          value={energy}
          onChange={(e) => setEnergy(e.target.value as EnergyLevel | '')}
          className={FIELD}
        >
          <option value="">—</option>
          <option value="light">лёгкая</option>
          <option value="heavy">тяжёлая</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Проект</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={FIELD}>
          <option value="">Входящие</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <div className="sm:col-span-2 flex items-center justify-end gap-2 border-t border-hair pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-control border border-rule px-3 py-1.5 text-sm transition-colors hover:bg-sunken"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={invalid || busy}
          className="rounded-control bg-accent px-4 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:bg-hair disabled:text-faint"
        >
          {template ? 'Сохранить' : 'Создать'}
        </button>
      </div>
    </form>
  )
}
