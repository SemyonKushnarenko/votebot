import { DateTime } from 'luxon';

export function parseDdMm(input) {
  const m = String(input).trim().match(/^(\d{1,2})[.\-\/](\d{1,2})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12)) return null;
  return { dd, mm };
}

export function parseHhMm(input) {
  const m = String(input).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const min = Number(m[2]);
  if (!(hh >= 0 && hh <= 23 && min >= 0 && min <= 59)) return null;
  return { hh, min };
}

export function toNextDateTime({ dd, mm, hh, min, tz }) {
  const now = DateTime.now().setZone(tz);
  let dt = DateTime.fromObject(
    { year: now.year, month: mm, day: dd, hour: hh, minute: min, second: 0, millisecond: 0 },
    { zone: tz }
  );
  if (!dt.isValid) return null;
  if (dt < now) {
    dt = dt.plus({ years: 1 });
  }
  return dt;
}

