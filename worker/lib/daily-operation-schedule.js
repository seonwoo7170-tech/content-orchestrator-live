function minutesOfDay(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

export function localClock(now = new Date(), timezone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('DAILY_OPERATION_LOCAL_TIME_INVALID');
  return { hour, minute, minutes: hour * 60 + minute };
}

export function hasDailyOperationStarted(settings = {}, now = new Date()) {
  const start = minutesOfDay(settings.dailyOperationStartTime || '03:00');
  if (start === null) throw new Error('DAILY_OPERATION_START_TIME_INVALID');
  const current = localClock(now, settings.timezone || 'Asia/Seoul').minutes;
  return current >= start;
}

export function isDailyOperationDue(settings = {}, now = new Date(), pollMinutes = 5) {
  const start = minutesOfDay(settings.dailyOperationStartTime || '03:00');
  if (start === null) throw new Error('DAILY_OPERATION_START_TIME_INVALID');
  const current = localClock(now, settings.timezone || 'Asia/Seoul').minutes;
  const delta = current - start;
  return delta >= 0 && delta < pollMinutes;
}
