import { db } from "./db.js";
import { getWIBDate } from "./api.js";

// Session hour ranges in WIB hour of day
export const SESSION_HOURS: Record<string, number[]> = {
  sydney: [4, 5, 6, 7, 8, 9], // 04:00–09:59 WIB
  tokyo: [6, 7, 8, 9, 10, 11, 12, 13], // 06:00–13:59 WIB
  london: [14, 15, 16, 17, 18, 19, 20, 21], // 14:00–21:59 WIB
  new_york: [19, 20, 21, 22, 23, 0, 1, 2], // 19:00–02:59 WIB
};

export interface SessionSchedule {
  london: boolean;
  new_york: boolean;
  sydney: boolean;
  tokyo: boolean;
}

/**
 * Retrieves the current session schedule from the db.
 */
export function getSessionSchedule(): SessionSchedule {
  return {
    london: db.configGet("session_sched_london", "1") === "1",
    new_york: db.configGet("session_sched_new_york", "1") === "1",
    sydney: db.configGet("session_sched_sydney", "1") === "1",
    tokyo: db.configGet("session_sched_tokyo", "1") === "1",
  };
}

/**
 * Saves the session schedule to the db.
 */
export function setSessionSchedule(schedule: Partial<SessionSchedule>): void {
  if (schedule.london !== undefined) db.configSet("session_sched_london", schedule.london ? "1" : "0");
  if (schedule.new_york !== undefined) db.configSet("session_sched_new_york", schedule.new_york ? "1" : "0");
  if (schedule.sydney !== undefined) db.configSet("session_sched_sydney", schedule.sydney ? "1" : "0");
  if (schedule.tokyo !== undefined) db.configSet("session_sched_tokyo", schedule.tokyo ? "1" : "0");
}

/**
 * Gets current session based on WIB time.
 * Overlaps prioritized: NY > London > Tokyo > Sydney.
 */
export function getCurrentSession(): string {
  const wib = getWIBDate(new Date());
  const h = wib.getHours();
  
  for (const sess of ["new_york", "london", "tokyo", "sydney"]) {
    if (SESSION_HOURS[sess].includes(h)) {
      return sess;
    }
  }
  return "off";
}

/**
 * Verifies if the current session is active/enabled.
 */
export function isSessionActive(): boolean {
  const sess = getCurrentSession();
  if (sess === "off") return false;
  if (sess === "tokyo") {
    // Tokyo Session is completely deactivated/disabled per user request
    return false;
  }
  
  const sched = getSessionSchedule();
  return (sched as any)[sess] ?? true;
}
