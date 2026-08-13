import { useMemo, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { taskIdOfEvent, useCalendarEvents } from '@/data/events'
import { defaultEnd, useScheduleTask } from '@/data/schedule'
import { addDays, startOfDay } from '@/lib/dates'
import { EventPopover } from './calendar/EventPopover'
import { TaskTray } from './TaskTray'
import type { Task } from '@/lib/types'

interface PopoverState {
  task: Task
  start: Date
  end: Date
  x: number
  y: number
}

/**
 * Time grid over the local mirror. App-owned events drag and resize back into
 * the task's schedule and open an action popover on click; foreign events stay
 * read-only busy blocks that link out to Google.
 */
export function CalendarGrid({ connected, tasks = [] }: { connected: boolean; tasks?: Task[] }) {
  // The visible window drives the query; FullCalendar reports it on navigation.
  const [range, setRange] = useState(() => ({
    from: startOfDay(new Date()),
    to: addDays(startOfDay(new Date()), 7),
  }))
  const [popover, setPopover] = useState<PopoverState | null>(null)

  // Mount-time decisions, deliberately not reactive: FullCalendar re-creates
  // its whole view on prop changes, which would drop scroll and selection.
  const [mobile] = useState(() => window.innerWidth < 640)
  const [scrollTime] = useState(() => {
    // Land one hour before "now" so the current slot sits near the top,
    // clamped into the 06:00–24:00 window the grid actually shows.
    const h = Math.min(23, Math.max(6, new Date().getHours() - 1))
    return `${String(h).padStart(2, '0')}:00:00`
  })

  const { data: events = [], isLoading, error } = useCalendarEvents(range.from, range.to, connected)
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
          // Meridian event blocks: context tint + 3px context-colored left edge,
          // styled in index.css — app-owned reads as ink, foreign as umber.
          classNames: [e.owned_by_app ? 'evt-app' : 'evt-ext'],
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
      <p className="rounded-card border border-dashed border-rule px-4 py-8 text-center text-sm text-faint">
        Сетка появится после подключения Google Calendar.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="rounded-control border border-danger/50 bg-surface px-3 py-2 text-sm text-danger">
          Не удалось прочитать события: {error.message}
        </p>
      )}

      {scheduleTask.error && (
        <p className="rounded-control border border-danger/50 bg-surface px-3 py-2 text-sm text-danger">
          Не удалось запланировать: {scheduleTask.error.message}
        </p>
      )}

      <TaskTray tasks={tasks} />

      {/* Fixed-height shell: the grid scrolls inside it instead of stretching
          the page, so the tray and toolbar stay in reach. */}
      <div className="calendar-shell relative h-[calc(100vh-16rem)] min-h-[560px] overflow-hidden rounded-card border border-hair bg-surface">
        <FullCalendar
          plugins={[timeGridPlugin, interactionPlugin]}
          initialView={mobile ? 'timeGridDay' : 'timeGridWeek'}
          views={{
            // Narrow screens can't read seven columns; three is the widest
            // multi-day view that still shows event titles.
            timeGridThreeDay: { type: 'timeGrid', duration: { days: 3 }, buttonText: '3 дня' },
          }}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: mobile ? 'timeGridDay,timeGridThreeDay' : 'timeGridWeek,timeGridDay',
          }}
          buttonText={{ today: 'сегодня', week: 'неделя', day: 'день' }}
          locale="ru"
          firstDay={1}
          height="100%"
          scrollTime={scrollTime}
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
            // Foreign events open in Google; app-owned ones (no url) get the
            // action popover anchored at the click.
            if (info.event.url) {
              info.jsEvent.preventDefault()
              window.open(info.event.url, '_blank', 'noopener')
              return
            }
            const source = events.find((e) => e.gcal_event_id === info.event.id)
            const taskId = source ? taskIdOfEvent(source) : null
            const task = taskId ? tasks.find((t) => t.id === taskId) : undefined
            if (!task || !info.event.start || !info.event.end) return
            setPopover({
              task,
              start: info.event.start,
              end: info.event.end,
              x: info.jsEvent.clientX,
              y: info.jsEvent.clientY,
            })
          }}
        />
        {isLoading && (
          <p className="absolute right-3 bottom-3 z-10 rounded-control border border-hair bg-surface px-2 py-1 font-mono text-[0.66rem] text-faint">
            Загружаем события…
          </p>
        )}
      </div>

      {popover && (
        <EventPopover
          task={popover.task}
          start={popover.start}
          end={popover.end}
          x={popover.x}
          y={popover.y}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}
