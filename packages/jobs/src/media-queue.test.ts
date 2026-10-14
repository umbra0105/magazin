import { describe, expect, it } from "vitest";
import { enqueueMediaProcessing, type MediaQueue } from "./media-queue";

/**
 * Cursa „jobul se termină exact între `getJob` și `getState`”: BullMQ întoarce atunci starea
 * `unknown` (jobul a fost șters la finalizare). Cererea de regenerare NU trebuie pierdută: altfel
 * rândul rămâne `pending` pentru totdeauna (nimic nu mai rulează).
 */
type State =
  | "completed"
  | "failed"
  | "active"
  | "waiting"
  | "delayed"
  | "prioritized"
  | "waiting-children"
  | "unknown";

function fakeQueue(script: { primary: (State | null)[]; rerun?: (State | null)[] }) {
  const added: string[] = [];
  const removed: string[] = [];
  const next = (list: (State | null)[] | undefined) => {
    const value = list && list.length > 1 ? list.shift() : list?.[0];
    return value ?? null;
  };
  const queue = {
    async getJob(id: string) {
      const state = id.endsWith("-rerun") ? next(script.rerun) : next(script.primary);
      if (state === null) return undefined;
      return {
        getState: async () => state,
        remove: async () => {
          removed.push(id);
        },
      };
    },
    async add(_name: string, _data: unknown, options: { jobId: string }) {
      added.push(options.jobId);
    },
  };
  return { queue: queue as unknown as MediaQueue, added, removed };
}

describe("enqueueMediaProcessing: cereri care nu se pierd", () => {
  it("jobul dispare între getJob și getState (stare „unknown”): se adaugă jobul principal", async () => {
    // prima citire: există; a doua (după reevaluare): a dispărut
    const { queue, added } = fakeQueue({ primary: ["unknown", null] });
    await enqueueMediaProcessing(queue, "m1");
    expect(added).toEqual(["media-m1"]);
  });

  it("job terminat sau eșuat: se scoate și se adaugă din nou", async () => {
    const { queue, added, removed } = fakeQueue({ primary: ["completed"] });
    await enqueueMediaProcessing(queue, "m1");
    expect(removed).toEqual(["media-m1"]);
    expect(added).toEqual(["media-m1"]);
  });

  it("job în așteptare sau amânat: nu se adaugă nimic (va procesa starea curentă)", async () => {
    for (const state of ["waiting", "delayed", "prioritized", "waiting-children"] as const) {
      const { queue, added } = fakeQueue({ primary: [state] });
      await enqueueMediaProcessing(queue, "m1");
      expect(added).toEqual([]);
    }
  });

  it("job activ: se adaugă o singură reluare", async () => {
    const { queue, added } = fakeQueue({ primary: ["active"], rerun: [null] });
    await enqueueMediaProcessing(queue, "m1");
    expect(added).toEqual(["media-m1-rerun"]);
  });

  it("jobul principal se termină exact când se șterge: ștergerea eșuată nu pierde cererea", async () => {
    const queue = {
      async getJob() {
        return {
          getState: async () => "completed" as const,
          remove: async () => {
            throw new Error("Missing key for job");
          },
        };
      },
      added: [] as string[],
      async add(_n: string, _d: unknown, o: { jobId: string }) {
        this.added.push(o.jobId);
      },
    };
    await enqueueMediaProcessing(queue as unknown as MediaQueue, "m1");
    expect(queue.added).toEqual(["media-m1"]);
  });
});
