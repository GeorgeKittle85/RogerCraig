// Lightweight natural-language time parsing plus due-item checking for
// schedule reminders. No external dependencies — covers the common
// phrasings ("in 20 minutes", "at 3pm", "tomorrow at 9am", ISO strings).
// Anything it can't parse is kept as a schedule note but simply won't ever
// fire a reminder (the /schedule list can still show it).

function parseClock(str, baseDate) {
  const m = str.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function parseWhen(text, now = new Date()) {
  if (!text) return null;
  const t = text.trim().toLowerCase();

  // "in N minutes/hours"
  let m = t.match(/^in\s+(\d+)\s*(minute|min|hour|hr)s?$/);
  if (m) {
    const amount = parseInt(m[1], 10);
    const unitMs = m[2].startsWith("hour") || m[2] === "hr" ? 3600000 : 60000;
    return new Date(now.getTime() + amount * unitMs);
  }

  // "tomorrow" / "tomorrow at H(:MM)(am|pm)"
  m = t.match(/^tomorrow(?:\s+at\s+(.+))?$/);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (m[1]) {
      const parsed = parseClock(m[1], d);
      if (parsed) return parsed;
    } else {
      d.setHours(9, 0, 0, 0);
      return d;
    }
  }

  // "at H(:MM)(am|pm)" — today, or tomorrow if that time already passed
  m = t.match(/^at\s+(.+)$/);
  if (m) {
    const d = parseClock(m[1], now);
    if (d) {
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
  }

  // A bare clock time with no "at", e.g. "3pm" or "15:30"
  const bare = parseClock(t, now);
  if (bare) {
    if (bare.getTime() <= now.getTime()) bare.setDate(bare.getDate() + 1);
    return bare;
  }

  // ISO-ish "YYYY-MM-DD HH:MM" or full ISO
  const iso = new Date(text.trim());
  if (!isNaN(iso.getTime())) return iso;

  return null;
}

// Scans the profile's schedule for items whose time has arrived and haven't
// been notified yet. Marks them notified and persists that immediately, so
// a reminder never fires twice even across restarts.
export function checkDueSchedule(profile, saveProfile) {
  const now = Date.now();
  const due = [];
  for (const item of profile.schedule) {
    if (item.notified || !item.whenISO) continue;
    if (new Date(item.whenISO).getTime() <= now) {
      item.notified = true;
      due.push(item);
    }
  }
  if (due.length) saveProfile(profile);
  return due;
}
