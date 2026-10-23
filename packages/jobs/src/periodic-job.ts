import { nextDailyRunAt } from "@ecom/shared";

/**
 * Programatorul comun al joburilor periodice (stoc: expirarea rezervărilor, prospețimea pozei, curățarea cererilor):
 *
 * - **interval** (`everyMs`: de la SFÂRȘITUL rulării precedente, deci două rulări ale aceluiași job nu se suprapun niciodată)
 *   sau **oră fixă** (`dailyAt`: HH:MM în fusul dat, recalculată după fiecare rulare, deci rămâne la aceeași oră locală peste
 *   schimbarea orei);
 * - programul poate fi o funcție, citită din nou după fiecare rulare (fusul orar schimbat din setări se aplică de la rularea
 *   următoare); un program invalid se loghează și se reîncearcă peste o oră, fără să ruleze nimic;
 * - o rulare care eșuează se loghează (cu numărul de eșecuri la rând) și programul continuă;
 * - joburile sunt idempotente și sigure la mai multe instanțe (vezi `StockMaintenance`), deci fiecare proces worker își
 *   rulează propriul program; nu e nevoie de coordonare prin Redis.
 */

export interface PeriodicJobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  debug?(obj: object, msg: string): void;
}

export type JobSchedule = { everyMs: number } | { dailyAt: string; timeZone: string };
export type ScheduleSource = JobSchedule | (() => JobSchedule | Promise<JobSchedule>);

export interface PeriodicJobOptions<R> {
  name: string;
  schedule: ScheduleSource;
  run: () => Promise<R>;
  /** Ce se raportează la nivel info; `null` = nimic de spus (rularea nu a avut efect). Implicit: rezultatul, dacă e obiect. */
  summarize?: (result: R) => object | null;
  logger: PeriodicJobLogger;
  /** Doar pentru `everyMs`: prima rulare după pornire (implicit 0). La oră fixă prima rulare e următoarea oră fixă. */
  initialDelayMs?: number;
}

export interface PeriodicJobStats {
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  lastError: string | null;
  nextRunAt: Date | null;
}

export interface PeriodicJobHandle {
  readonly name: string;
  close(): void;
  stats(): PeriodicJobStats;
}

const INVALID_SCHEDULE_RETRY_MS = 3_600_000;
const MAX_TIMER_MS = 2_147_483_647;

function assertSchedule(schedule: JobSchedule): void {
  if ("everyMs" in schedule && (!Number.isInteger(schedule.everyMs) || schedule.everyMs < 1)) {
    throw new RangeError(
      "Intervalul jobului trebuie să fie un număr întreg de milisecunde, cel puțin 1",
    );
  }
}

export function startPeriodicJob<R>(options: PeriodicJobOptions<R>): PeriodicJobHandle {
  const { name, logger } = options;
  if (typeof options.schedule !== "function") assertSchedule(options.schedule);

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stats: PeriodicJobStats = {
    runs: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastRunAt: null,
    lastError: null,
    nextRunAt: null,
  };

  const wait = (delayMs: number, then: () => void): void => {
    if (closed) return;
    const delay = Math.min(Math.max(delayMs, 0), MAX_TIMER_MS);
    stats.nextRunAt = new Date(Date.now() + delay);
    timer = setTimeout(then, delay);
    timer.unref?.();
  };

  const resolveSchedule = async (): Promise<JobSchedule> => {
    const schedule =
      typeof options.schedule === "function" ? await options.schedule() : options.schedule;
    assertSchedule(schedule);
    return schedule;
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    stats.runs++;
    stats.lastRunAt = new Date();
    try {
      const result = await options.run();
      stats.consecutiveFailures = 0;
      stats.lastError = null;
      const summary = options.summarize
        ? options.summarize(result)
        : result !== null && typeof result === "object"
          ? (result as object)
          : null;
      if (summary) logger.info({ job: name, ...summary }, `job ${name}: rulat`);
      else logger.debug?.({ job: name }, `job ${name}: nimic de făcut`);
    } catch (error) {
      stats.failures++;
      stats.consecutiveFailures++;
      stats.lastError = error instanceof Error ? error.message : String(error);
      logger.warn(
        { job: name, consecutiveFailures: stats.consecutiveFailures, err: stats.lastError },
        `job ${name}: rularea a eșuat; se reia la următorul termen`,
      );
    }
    void arm(false);
  };

  /** Programează următoarea rulare. `first` = prima după pornire (poate avea întârziere proprie). */
  const arm = async (first: boolean): Promise<void> => {
    if (closed) return;
    let schedule: JobSchedule;
    try {
      schedule = await resolveSchedule();
    } catch (error) {
      logger.warn(
        { job: name, err: error instanceof Error ? error.message : String(error) },
        `job ${name}: programul nu e valid; reîncerc peste o oră`,
      );
      wait(INVALID_SCHEDULE_RETRY_MS, () => void arm(first));
      return;
    }
    if (closed) return;
    if ("everyMs" in schedule) {
      wait(first ? (options.initialDelayMs ?? 0) : schedule.everyMs, () => void tick());
      return;
    }
    try {
      const now = new Date();
      const next = nextDailyRunAt(now, schedule.dailyAt, schedule.timeZone);
      wait(next.getTime() - now.getTime(), () => void tick());
    } catch (error) {
      logger.warn(
        { job: name, err: error instanceof Error ? error.message : String(error) },
        `job ${name}: programul nu e valid; reîncerc peste o oră`,
      );
      wait(INVALID_SCHEDULE_RETRY_MS, () => void arm(first));
    }
  };

  void arm(true);
  return {
    name,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      stats.nextRunAt = null;
    },
    stats: () => ({ ...stats }),
  };
}
