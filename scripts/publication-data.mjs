const PUBLICATION_KEYS = new Set(['value', 'precision', 'certainty', 'basis', 'evidence', 'reasoning', 'assessedAt', 'method', 'model']);
const REQUIRED_KEYS = [...PUBLICATION_KEYS].filter(key => key !== 'model');
const PRECISIONS = ['year', 'month', 'day', 'minute'];
const MONTHS = new Map(['january jan', 'february feb', 'march mar', 'april apr', 'may', 'june jun', 'july jul', 'august aug', 'september sept sep', 'october oct', 'november nov', 'december dec'].flatMap((names, index) => names.split(' ').map(name => [name, index + 1])));
const MONTH_PATTERN = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join('|');
const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

function calendar(year, month = 1, day = 1) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function timezoneMinutes(zone) {
  if (zone === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!match) return null;
  const hours = Number(match[2]), minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || zone === '-00:00') return null;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}
function instant(value, { minute = false } = {}) {
  if (typeof value !== 'string') return null;
  const expression = minute
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
  const match = expression.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minutes = Number(match[5]);
  const seconds = minute ? 0 : Number(match[6]);
  const milliseconds = minute ? 0 : Number((match[7] || '').padEnd(3, '0'));
  const offset = timezoneMinutes(match[minute ? 6 : 8]);
  if (!calendar(year, month, day) || hour > 23 || minutes > 59 || seconds > 59 || offset === null) return null;
  return Date.UTC(year, month - 1, day, hour, minutes, seconds, milliseconds) - offset * 60_000;
}
function dateValue(value, precision) {
  if (typeof value !== 'string') return null;
  if (precision === 'minute') {
    const timestamp = instant(value, { minute: true });
    return timestamp === null ? null : { timestamp };
  }
  const expression = { year: /^(\d{4})$/, month: /^(\d{4})-(\d{2})$/, day: /^(\d{4})-(\d{2})-(\d{2})$/ }[precision];
  const match = expression?.exec(value);
  if (!match || !calendar(Number(match[1]), Number(match[2] || 1), Number(match[3] || 1))) return null;
  return { year: Number(match[1]), month: match[2] ? Number(match[2]) : null, day: match[3] ? Number(match[3]) : null };
}
function localKey(timestamp, precision) {
  const parts = Object.fromEntries(shanghaiDate.formatToParts(timestamp).filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, part.value]));
  return [parts.year, ...(precision !== 'year' ? [parts.month] : []), ...(precision === 'day' ? [parts.day] : [])].join('-');
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function evidenceUrl(value) {
  if (typeof value !== 'string' || !value.length || value.length > 2000 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !isIP(host.replace(/^\[|\]$/g, ''))
      && host.includes('.') && host.length <= 253 && !host.endsWith('.')
      && !/(?:^|\.)(?:localhost|local|internal|localdomain|home|lan|test|invalid|example)$/.test(host)
      && host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
  }
  catch { return false; }
}

/** Validate public date metadata without guessing dates from collection times. */
export function validatePublication(value, { now = Date.now(), discoveredAt } = {}) {
  if (!object(value)) return ['publication must be an object'];
  const errors = [];
  if (Object.keys(value).some(key => !PUBLICATION_KEYS.has(key))) errors.push('publication contains unsupported fields');
  if (REQUIRED_KEYS.some(key => !Object.hasOwn(value, key))) errors.push('publication is missing required fields');
  if (!['exact', 'approximate', 'unknown'].includes(value.certainty)) errors.push('publication certainty is invalid');
  if (!['gpt-web-search', 'manual'].includes(value.method)) errors.push('publication method is invalid');
  if ((value.method === 'gpt-web-search' || value.model !== undefined) && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200)) errors.push('publication model must identify the GPT model');
  if (typeof value.reasoning !== 'string' || !value.reasoning.trim() || value.reasoning.length > 600) errors.push('publication reasoning must contain 1–600 characters');
  const assessedAt = instant(value.assessedAt);
  if (assessedAt === null) errors.push('publication assessedAt must be a real ISO date with timezone');
  else if (assessedAt > now + 300_000) errors.push('publication assessedAt cannot be in the future');
  if (!Array.isArray(value.evidence) || value.evidence.length > 3 || value.evidence.some(item => !object(item) || Object.keys(item).some(key => !['url', 'quote'].includes(key)) || !evidenceUrl(item.url) || typeof item.quote !== 'string' || item.quote.trim().length < 3 || item.quote.length > 260)) errors.push('publication evidence needs at most 3 bounded HTTPS URLs and literal quotes');

  if (value.certainty === 'unknown') {
    if (value.value !== null || value.precision !== null || value.basis !== null) errors.push('unknown publication must have null value, precision and basis');
  } else {
    if (!PRECISIONS.includes(value.precision)) errors.push('publication precision is invalid');
    if (!['published', 'available_by'].includes(value.basis)) errors.push('publication basis is invalid');
    if (value.basis === 'available_by' && value.certainty !== 'approximate') errors.push('available_by publication must be approximate');
    if (['year', 'month'].includes(value.precision) && value.certainty !== 'approximate') errors.push('year and month publication must be approximate');
    if (!Array.isArray(value.evidence) || !value.evidence.length) errors.push('known publication needs public date evidence');
    const parsed = dateValue(value.value, value.precision);
    if (!parsed) errors.push('publication value must be a real date matching its precision, from 1970 onward');
    else {
      if (value.precision === 'minute' ? parsed.timestamp > now : value.value > localKey(now, value.precision)) errors.push('publication date cannot be in the future');
      const discovery = instant(discoveredAt);
      if (discovery !== null && (value.precision === 'minute' ? parsed.timestamp > discovery : value.value > localKey(discovery, value.precision))) errors.push('publication date cannot be after first discovery');
    }
  }
  return errors;
}

function quotedDates(text) {
  const dates = [];
  function add(match, year, month, day) {
    year = Number(year); month = month ? Number(month) : null; day = day ? Number(day) : null;
    if (calendar(year, month || 1, day || 1)) dates.push({ year, month, day, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(/(?<!\d)(\d{4})([-/])(\d{1,2})(?:\2(\d{1,2}))?(?!\d|[-/]\d)/g)) add(match, match[1], match[3], match[4]);
  for (const match of text.matchAll(/(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*(?:日|号)|(?!\s*\d))/g)) add(match, match[1], match[2], match[3]);
  const monthFirst = new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,\\s*|\\s+))?(\\d{4})(?!\\d)`, 'gi');
  const dayFirst = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?(?:\\s*,\\s*|\\s+)(\\d{4})(?!\\d)`, 'gi');
  for (const match of text.matchAll(monthFirst)) add(match, match[3], MONTHS.get(match[1].toLowerCase()), match[2]);
  for (const match of text.matchAll(dayFirst)) add(match, match[3], MONTHS.get(match[2].toLowerCase()), match[1]);
  return dates;
}
function quotedMinute(date, text) {
  if (!date.month || !date.day) return null;
  const time = /^(?:\s*(?:at|T|,)?\s*)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?\s*(AM|PM)?\s*(Z|(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2}|北京时间)(?![\w:+-])/i.exec(text.slice(date.end));
  if (!time) return null;
  let hour = Number(time[1]);
  if (time[4]) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (time[4].toUpperCase() === 'PM' ? 12 : 0); }
  if (hour > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59) return null;
  let zone = time[5].toUpperCase();
  if (zone === '北京时间') zone = '+08:00';
  else if (zone === 'UTC' || zone === 'GMT') zone = 'Z';
  else {
    zone = zone.replace(/^(UTC|GMT)/, '');
    const offset = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
    if (offset) zone = `${offset[1]}${offset[2].padStart(2, '0')}:${offset[3] || '00'}`;
  }
  const offset = timezoneMinutes(zone);
  return offset === null ? null : Date.UTC(date.year, date.month - 1, date.day, hour, Number(time[2])) - offset * 60_000;
}

/** Date presence is a mechanical check; the caller must also verify the quote,
 * source identity and that the date describes this benefit's announcement. */
export function publicationDateSupported(value, precision, quote) {
  const parsed = dateValue(value, precision);
  if (!parsed || typeof quote !== 'string' || !quote.trim() || quote.length > 10_000) return false;
  const text = quote.normalize('NFKC').replace(/\s+/g, ' ');
  const dates = quotedDates(text);
  if (precision === 'year') return dates.some(date => date.year === parsed.year) || [...text.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].some(match => Number(match[1]) === parsed.year);
  if (precision === 'month') return dates.some(date => date.year === parsed.year && date.month === parsed.month);
  if (precision === 'day') return dates.some(date => date.year === parsed.year && date.month === parsed.month && date.day === parsed.day);
  return dates.some(date => quotedMinute(date, text) === parsed.timestamp);
}
import { isIP } from 'node:net';

