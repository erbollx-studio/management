import { useMemo, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { taskIdOfEvent, useCalendarEvents, useSyncNow } from '@/data/events'
import { defaultEnd, useScheduleTask } from '@/data/schedule'
import { addDays, startOfDay } from '@/lib/dates'
import { TaskTray } from './TaskTray'
import type { Task } from '@/lib/types'

/**
 * Week grid over the local mirror. App-owned events drag and resize back into
 * the task's schedule; foreign events stay read-only busy blocks.
 */
export function CalendarGrid({ connected, tasks = [] }: { connected: boolean; tasks?: Task[] }) {
  // The visible window drives the query; FullCalendar reports it on navigation.
  const [range, setRange] = useState(() => ({
    from: startOfDay(new Date()),
    to: addDays(startOfDay(new Date()), 7),
  }))

  const { data: events = [], isLoading, error } = useCalendarEvents(range.from, range.to, connected)
  const sync = useSyncNow()
  const scheduleTask = useScheduleTask()

  const fcEvents = useMemo(
    () =>
      events
        .filter((e) => e.start_at && e.end_at)
        .map((e) => ({
          id: e.gcal_event_id,
          title: e.summary ?? '(без названия)',
          start: e.start_at!,
          end: e.end_at!,
          allDay: e.is_all_day,
          // Only foreign events open in Google — app-owned ones are edited here.
          url: e.owned_by_app ? undefined : (e.html_link ?? undefined),
          editable: e.owned_by_app,
          startEditable: e.owned_by_app,
          durationEditable: e.owned_by_app,
          backgroundColor: e.owned_by_app ? 'var(--c-accent)' : 'var(--c-prio-1)',
          borderColor: 'transparent',
        })),
    [events],
  )

  /** Shared by eventDrop and eventResize: both mean "the task moved". */
  function rescheduleFromEvent(info: {
    event: { id: string; start: Date | null; end: Date | null }
    revert: () => void
  }) {
    const source = events.find((e) => e.gcal_event_id === info.event.id)
    const taskId = source ? taskIdOfEvent(source) : null
    if (!taskId || !info.event.start || !info.event.end) {
      // No task behind the event (or FC lost the times) — nothing to write.
      info.revert()
      return
    }
    scheduleTask.mutate({ taskId, start: info.event.start, end: info.event.end })
  }

  if (!connected) {
    return (
      <p className="border border-dashed border-hair px-4 py-8 text-center text-sm text-faint">
        Сетка появится после подключения Google Calendar.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="border border-hair px-3 py-1.5 font-mono text-[0.72rem] text-muted hover:text-ink disabled:opacity-50"
        >
          {sync.isPending ? 'Синхронизация…' : 'Синхронизировать'}
        </button>
        <span className="font-mono text-[0.66rem] text-faint">
          {sync.data && `обновлено событий: ${sync.data.changed}${sync.data.full ? ' (полная)' : ''}`}
          {sync.error && <span className="text-danger">{sync.error.message}</span>}
        </span>
      </div>

      {error && (
        <p className="border border-danger px-3 py-2 text-sm text-danger">
          Не удалось прочитать события: {error.message}
        </p>
      )}

      {scheduleTask.error && (
        <p className="border border-danger px-3 py-2 text-sm text-danger">
          Не удалось запланировать: {scheduleTask.error.message}
        </p>
      )}

      <TaskTray tasks={tasks} />

      <div className="calendar-shell border border-hair bg-surface">
        <FullCalendar
          plugins={[timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay' }}
          buttonText={{ today: 'сегодня', week: 'неделя', day: 'день' }}
          locale="ru"
          firstDay={1}
          height="auto"
          allDaySlot
          allDayText="весь день"
          slotMinTime="06:00:00"
          slotMaxTime="24:00:00"
          nowIndicator
          events={fcEvents}
          droppable
          datesSet={(info) => setRange({ from: info.start, to: info.end })}
          drop={(info) => {
            // External drag from the tray. The Draggable is create:false, so no
            // ghost event appears — the mirror refresh renders the real one.
            const taskId = info.draggedEl.getAttribute('data-task-id')
            if (!taskId) return
            const estimate = Number(info.draggedEl.getAttribute('data-estimate')) || null
            scheduleTask.mutate({ taskId, start: info.date, end: defaultEnd(info.date, estimate) })
          }}
          eventDrop={rescheduleFromEvent}
          eventResize={rescheduleFromEvent}
          eventClick={(info) => {
            // Foreign events open in Google; app-owned ones have no url and are
            // edited by dragging instead.
            if (info.event.url) {
              info.jsEvent.preventDefault()
              window.open(info.event.url, '_blank', 'noopener')
            }
          }}
        />
        {isLoading && <p className="px-4 py-3 text-sm text-faint">Загружаем события…</p>}
      </div>
    </div>
  )
}
