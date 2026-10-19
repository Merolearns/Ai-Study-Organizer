/**
 * Schedule Output Validator
 * -------------------------
 * Post-generation validation for LLM-produced study schedules.
 *
 * Validates that a generated schedule text:
 *  1. Is non-empty and has minimum viable content
 *  2. Contains parseable day-of-week sections
 *  3. Contains parseable time slots
 *  4. Does not schedule study blocks overlapping class times
 *
 * Usage:
 *   const result = validateScheduleOutput(scheduleText, classes);
 *   if (!result.valid) {
 *     console.error(result.errors);
 *   }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassInfo {
  name: string;
  /** e.g. "Mon/Wed", "Monday, Wednesday", "MWF", "TTh" */
  days: string;
  /** e.g. "10:00 AM", "10 AM", "10:00" */
  startTime: string;
  /** e.g. "11:20 AM", "11:20" */
  endTime: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface TimeSlot {
  /** minutes since midnight */
  start: number;
  end: number;
  /** the day index (0=Sunday … 6=Saturday) this slot belongs to, -1 if unknown */
  day: number;
  raw: string;
}

// ---------------------------------------------------------------------------
// Day helpers
// ---------------------------------------------------------------------------

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const DAY_ABBREVS: Record<string, number> = {
  sun: 0, sunday: 0, su: 0,
  mon: 1, monday: 1, m: 1, mo: 1,
  tue: 2, tues: 2, tuesday: 2, t: 2, tu: 2,
  wed: 3, wednesday: 3, w: 3, we: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, th: 4, r: 4,
  fri: 5, friday: 5, f: 5, fr: 5,
  sat: 6, saturday: 6, sa: 6, s: 6,
};

/**
 * Parse a free-form days string into a set of day indices (0=Sun … 6=Sat).
 * Handles: "Mon/Wed", "Monday, Wednesday", "MWF", "TTh", "Mon-Fri", "daily", etc.
 */
export function parseDays(daysStr: string): Set<number> {
  const result = new Set<number>();
  const lower = daysStr.toLowerCase().trim();

  if (!lower) return result;
  if (lower === "daily" || lower === "every day" || lower === "everyday") {
    return new Set([0, 1, 2, 3, 4, 5, 6]);
  }
  if (lower === "weekdays") {
    return new Set([1, 2, 3, 4, 5]);
  }
  if (lower === "weekends") {
    return new Set([0, 6]);
  }

  // Handle ranges like "Mon-Fri" or "Monday-Friday"
  const rangeMatch = lower.match(/^([a-z]+)\s*[-–—]\s*([a-z]+)$/);
  if (rangeMatch) {
    const start = DAY_ABBREVS[rangeMatch[1]];
    const end = DAY_ABBREVS[rangeMatch[2]];
    if (start !== undefined && end !== undefined) {
      let d = start;
      // walk forward, wrapping around the week if needed
      for (let i = 0; i < 7; i++) {
        result.add(d);
        if (d === end) break;
        d = (d + 1) % 7;
      }
      return result;
    }
  }

  // Split on common separators first: "/", ",", ";", "|", "&", "+", whitespace runs
  const tokens = lower.split(/[\/,;|&+]+/).flatMap((t) => t.split(/\s+/));

  for (const token of tokens) {
    const t = token.trim().replace(/[^a-z]/g, "");
    if (!t) continue;

    // Direct lookup (handles "mon", "monday", "m", etc.)
    if (DAY_ABBREVS[t] !== undefined) {
      result.add(DAY_ABBREVS[t]);
      continue;
    }

    // Compact runs like "mwf", "tth", "mtwthf" — try to split into known abbrevs
    // Greedy match: try 2-char then 1-char chunks
    let rest = t;
    let matched = false;
    const runDays: number[] = [];
    let temp = rest;
    while (temp.length > 0) {
      let found = false;
      // try longest-first: check known multi-char tokens
      for (const key of Object.keys(DAY_ABBREVS).sort((a, b) => b.length - a.length)) {
        if (temp.startsWith(key) && key.length > 1) {
          runDays.push(DAY_ABBREVS[key]);
          temp = temp.slice(key.length);
          found = true;
          break;
        }
      }
      if (!found) {
        // single char
        const ch = temp[0];
        if (DAY_ABBREVS[ch] !== undefined) {
          runDays.push(DAY_ABBREVS[ch]);
          temp = temp.slice(1);
          found = true;
        } else {
          break; // unparseable remainder
        }
      }
    }
    if (temp.length === 0 && runDays.length > 0) {
      runDays.forEach((d) => result.add(d));
      matched = true;
    }
    void matched;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Parse a time string into minutes since midnight.
 * Handles: "8:00 AM", "8 AM", "08:00", "8:00am", "20:00", "8am", "12:30 PM", etc.
 * Returns null if unparseable.
 */
export function parseTime(timeStr: string): number | null {
  const t = timeStr.trim().toLowerCase().replace(/\s+/g, " ");

  // Match: HH:MM AM/PM | HH AM/PM | HH:MM (24h) | HHMM edge cases
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const meridiem = m[3]; // 'a' or 'p'

    if (hour < 1 || hour > 12 || minute > 59) return null;

    if (meridiem === "p" && hour !== 12) hour += 12;
    if (meridiem === "a" && hour === 12) hour = 0;

    return hour * 60 + minute;
  }

  // 24-hour format: "14:30" or "0830"
  const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const hour = parseInt(m24[1], 10);
    const minute = parseInt(m24[2], 10);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  return null;
}

/**
 * Extract time slots from a line of schedule text.
 * Matches patterns like "8:00 AM - 9:30 AM", "8 AM–10 AM", "14:00-15:30".
 */
const TIME_RANGE_RE =
  /(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?|\d{1,2}:\d{2})\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?|\d{1,2}:\d{2})/gi;

export function extractTimeSlots(line: string, day: number): TimeSlot[] {
  const slots: TimeSlot[] = [];
  // reset regex state for global flag
  TIME_RANGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIME_RANGE_RE.exec(line)) !== null) {
    const start = parseTime(match[1]);
    const end = parseTime(match[2]);
    if (start !== null && end !== null && end > start) {
      slots.push({ start, end, day, raw: match[0] });
    }
  }
  return slots;
}

/** Do two time ranges overlap? */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

const DAY_HEADER_RE =
  /^\s*(?:#{1,4}\s*)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

export function validateScheduleOutput(
  scheduleText: string,
  classes: ClassInfo[]
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- 1. Non-empty check ---------------------------------------------------
  if (!scheduleText || !scheduleText.trim()) {
    return { valid: false, errors: ["Schedule output is empty."], warnings };
  }

  const text = scheduleText.trim();

  if (text.length < 100) {
    warnings.push(
      `Schedule text is unusually short (${text.length} chars) — may be truncated.`
    );
  }

  // --- 2. Day-section check -------------------------------------------------
  const lines = text.split("\n");
  const daysFound = new Set<number>();
  // Map each line index to its day section
  const lineDay: number[] = new Array(lines.length).fill(-1);
  let currentDay = -1;

  for (let i = 0; i < lines.length; i++) {
    const dm = lines[i].match(DAY_HEADER_RE);
    if (dm) {
      const dayIdx = DAY_NAMES.indexOf(
        dm[1].toLowerCase() as (typeof DAY_NAMES)[number]
      );
      if (dayIdx >= 0) {
        daysFound.add(dayIdx);
        currentDay = dayIdx;
      }
    }
    lineDay[i] = currentDay;
  }

  if (daysFound.size === 0) {
    errors.push(
      "No day-of-week sections found — expected headers like 'Monday', 'Tuesday', etc."
    );
  } else if (daysFound.size < 3) {
    warnings.push(
      `Only ${daysFound.size} day section(s) found — a full weekly schedule usually covers 5–7 days.`
    );
  }

  // --- 3. Time-slot extraction & parse check --------------------------------
  const allSlots: TimeSlot[] = [];
  let unparseableLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure header lines and lines with no digits
    if (!/\d/.test(line)) continue;
    const slots = extractTimeSlots(line, lineDay[i]);
    if (slots.length === 0) {
      // Line has digits but no parseable time range — could be a date or stray number
      // Only count it if it looks like it *tried* to be a time (has : or AM/PM)
      if (/[:]\d{2}/.test(line) || /[ap]\.?m\.?/i.test(line)) {
        unparseableLines++;
      }
    }
    allSlots.push(...slots);
  }

  if (allSlots.length === 0 && daysFound.size > 0) {
    errors.push(
      "No parseable time slots found in the schedule — expected ranges like '8:00 AM - 9:30 AM'."
    );
  }

  if (unparseableLines > allSlots.length) {
    warnings.push(
      `${unparseableLines} line(s) looked like times but could not be parsed — output format may be inconsistent.`
    );
  }

  // --- 4. Class-overlap check -----------------------------------------------
  for (const cls of classes) {
    const classDays = parseDays(cls.days);
    const classStart = parseTime(cls.startTime);
    const classEnd = parseTime(cls.endTime);

    if (classStart === null || classEnd === null) {
      warnings.push(
        `Could not parse class time for "${cls.name}" (${cls.startTime} - ${cls.endTime}) — skipping overlap check for this class.`
      );
      continue;
    }
    if (classDays.size === 0) {
      warnings.push(
        `Could not parse days for "${cls.name}" ("${cls.days}") — skipping overlap check for this class.`
      );
      continue;
    }

    for (const slot of allSlots) {
      if (slot.day === -1) continue; // slot not under a day header — can't attribute
      if (!classDays.has(slot.day)) continue;
      if (rangesOverlap(slot.start, slot.end, classStart, classEnd)) {
        const dayName = DAY_NAMES[slot.day];
        errors.push(
          `Overlap: study block "${slot.raw.trim()}" on ${dayName} conflicts with class "${cls.name}" (${cls.startTime}–${cls.endTime}).`
        );
      }
    }
  }

  // --- 5. Sanity: no absurdly long single blocks ----------------------------
  for (const slot of allSlots) {
    const durationHrs = (slot.end - slot.start) / 60;
    if (durationHrs > 6) {
      warnings.push(
        `Unusually long study block (${durationHrs.toFixed(1)}h: "${slot.raw.trim()}") — may indicate a parsing error or unrealistic schedule.`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
