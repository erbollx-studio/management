import { useEffect, useMemo, useState } from 'react'
import {
  useCreateTemplate,
  useDeleteTemplate,
  useGenerateNow,
  useTemplates,
  useUpdateTemplate,
} from '@/data/templates'
import { cx } from '@/lib/cx'
import { formatEstimate } from '@/lib/dates'
import type { Project, TaskTemplate, TemplateInsert } from '@/lib/types'
import { useToast } from '@/ui/toast'
import { TemplateEditor } from './TemplateEditor'
import { PRIORITY_COLOR, PRIORITY_LABEL, formatRepeatRule, toHHMM } from './lib'

/**
 * «Повторяющиеся» — the templates behind auto-generated daily tasks. Only the
 * rules live here; the tasks they produce show up in the regular lists.
 */
export function RecurringView({ projects }: { projects: Project[] }) {
  const query = useTemplates()
  const create = useCreateTemplate()
  const update = useUpdateTemplate()
  const del = useDeleteTemplate()
  const generate = useGenerateNow()
  const { toast } = useToast()

  // 'new' → creating; a template id → that card is in edit mode.
  const [editing, setEditing] = useState<'new' | string | null>(null)

  const templates = query.data ?? []
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  async function runGenerate() {
    try {
      const n = await generate.mutateAsync()
      toast({ message: n > 0 ? `Создано задач: ${n}` : 'Новых задач нет' })
    } catch {
      toast({ message: 'Не удалось сгенерировать задачи', tone: 'danger' })
    }
  }

  async function handleSave(input: TemplateInsert) {
    try {
      if (editing && editing !== 'new') await update.mutateAsync({ id: editing, patch: input })
      else await create.mutateAsync(input)
    } catch {
      toast({ message: 'Не удалось сохранить шаблон', tone: 'danger' })
      return
    }
    setEditing(null)
    // A fresh or changed template should show up in today's list right away
    // instead of waiting for the nightly cron.
    await runGenerate()
  }

  const saving = create.isPending || update.isPending

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
        <div>
          <h2 className="font-serif text-2xl font-semibold">Повторяющиеся</h2>
          <p className="mt-0.5 max-w-md text-xs text-muted">
            Шаблоны создают задачи автоматически каждый день в 00:05 UTC
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runGenerate}
            disabled={generate.isPending}
            className="rounded-control border border-rule px-3 py-1.5 text-sm transition-colors hover:bg-sunken disabled:text-faint"
          >
            {generate.isPending ? 'Генерируем…' : 'Сгенерировать сейчас'}
          </button>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="rounded-control bg-accent px-4 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-ink"
          >
            Создать шаблон
          </button>
        </div>
      </header>

      {query.isPending ? (
        <p className="px-1 py-6 text-sm text-faint">Загрузка…</p>
      ) : query.isError ? (
        <p className="px-1 py-6 text-sm text-danger">Не удалось загрузить шаблоны</p>
      ) : templates.length === 0 && editing !== 'new' ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-rule px-4 py-10 text-center">
          <p className="max-w-sm text-sm text-muted">
            Повторяющихся задач пока нет. Например: планёрка по будням в 10:00.
          </p>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="rounded-control bg-accent px-4 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-ink"
          >
            Создать шаблон
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {editing === 'new' && (
            <li>
              <TemplateEditor
                template={null}
                projects={projects}
                busy={saving}
                onSave={handleSave}
                onCancel={() => setEditing(null)}
              />
            </li>
          )}
          {templates.map((t) => (
            <li key={t.id}>
              {editing === t.id ? (
                <TemplateEditor
                  template={t}
                  projects={projects}
                  busy={saving}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <TemplateCard
                  template={t}
                  project={t.project_id ? (projectById.get(t.project_id) ?? null) : null}
                  onToggleActive={() => update.mutate({ id: t.id, patch: { active: !t.active } })}
                  onEdit={() => setEditing(t.id)}
                  onDelete={() => del.mutate(t.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TemplateCard({
  template: t,
  project,
  onToggleActive,
  onEdit,
  onDelete,
}: {
  template: TaskTemplate
  project: Project | null
  onToggleActive: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-card border border-hair bg-surface px-3 py-2.5',
        !t.active && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1 basis-52">
        <p className="text-sm font-medium">{t.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.68rem] text-muted">
          <span>{formatRepeatRule(t)}</span>
          {t.due_time && <span>{toHHMM(t.due_time)}</span>}
          {t.estimate_minutes !== null && <span>{formatEstimate(t.estimate_minutes)}</span>}
          {PRIORITY_COLOR[t.priority] && (
            <span className="flex items-center gap-1">
              <span
                className="size-1.5 rounded-full"
                style={{ background: PRIORITY_COLOR[t.priority] ?? undefined }}
                aria-hidden="true"
              />
              {PRIORITY_LABEL[t.priority]}
            </span>
          )}
          {t.energy && (
            <span title={t.energy === 'light' ? 'Лёгкая задача' : 'Тяжёлая задача'}>
              {t.energy === 'light' ? '⚡' : '⚡⚡'}
            </span>
          )}
          {project && (
            <span
              className="rounded-[4px] px-1.5 py-px font-sans text-[0.69rem] font-medium"
              style={{
                // Mixing toward the text token keeps DB palette colors legible
                // on both the ivory and the charcoal surfaces.
                color: `color-mix(in srgb, ${project.color} 60%, var(--c-ink))`,
                background: `color-mix(in srgb, ${project.color} 14%, transparent)`,
              }}
            >
              {project.name}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={t.active}
          aria-label={t.active ? 'Выключить шаблон' : 'Включить шаблон'}
          onClick={onToggleActive}
          className={cx(
            'relative h-4.5 w-8 rounded-full border transition-colors',
            t.active ? 'border-accent bg-accent' : 'border-rule bg-sunken',
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'absolute top-1/2 size-3 -translate-y-1/2 rounded-full transition-[left]',
              t.active ? 'left-[calc(100%-0.875rem)] bg-ground' : 'left-0.5 bg-faint',
            )}
          />
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-control border border-rule px-2.5 py-1 font-mono text-[0.7rem] transition-colors hover:border-accent"
        >
          Изменить
        </button>
        <DeleteButton onDelete={onDelete} />
      </div>
    </div>
  )
}

/** Two-step delete: first click arms the button, 3s of inaction disarms it. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    // Revert so a stray first click can't leave a destructive button waiting.
    const id = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(id)
  }, [armed])

  return (
    <button
      type="button"
      onClick={() => (armed ? onDelete() : setArmed(true))}
      className={cx(
        'rounded-control border px-2.5 py-1 font-mono text-[0.7rem] transition-colors',
        armed
          ? 'border-danger bg-danger text-ground'
          : 'border-rule text-danger hover:border-danger',
      )}
    >
      {armed ? 'Точно удалить?' : 'Удалить'}
    </button>
  )
}
