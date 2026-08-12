import { useMemo, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { useCalendarEvents, useSyncNow } from '@/data/events'
import { addDays, startOfDay } from '@/lib/dates'

/**
 * Week grid over the local mirror. Events are read-only busy blocks in phase 2;
 * dragging arrives with phase 3 when tasks can be written to Google.
 */
export function CalendarGrid({ connected }: { connected: boolean }) {
  // The visible window drives the query; FullCalendar reports it on navigation.
  const [range, setRange] = useState(() => ({
    from: startOfDay(new Date()),
    to: addDays(startOfDay(new Date()), 7),
  }))

  const { data: events = [], isLoading, error } = useCalendarEvents(range.from, range.to, connected)
  const sync = useSyncNow()

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
          url: e.html_link ?? undefined,
          // Phase 3 will colour app-owned events by project instead.
          backgroundColor: e.owned_by_app ? 'var(--c-accent)' : 'var(--c-prio-1)',
          borderColor: 'transparent',
        })),
    [events],
  )

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
          datesSet={(info) => setRange({ from: info.start, to: info.end })}
          eventClick={(info) => {
            // Open in Google rather than editing locally — phase 2 is read-only.
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
