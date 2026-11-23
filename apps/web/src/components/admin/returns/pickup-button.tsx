"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@ecom/ui";
import { markPickedUpAction } from "@/app/(admin)/admin/comenzi/ridicare-actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.returns.orderSection;

/** «Marchează ridicată»: consemnează ridicarea personală (pornește fereastra de retur). */
export function PickupButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    setProblem(null);
    try {
      const result = await markPickedUpAction({ orderId });
      if (result.ok) {
        setMessage(m.pickedUpDone);
        router.refresh();
      } else {
        setProblem(m.pickupErrors[result.code] ?? m.pickupErrors["failed"] ?? "");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-pickup-panel>
      <p className="max-w-prose text-body text-ink-secondary">{m.markPickedUpHint}</p>
      <div>
        <Button type="button" variant="outline" onClick={run} disabled={busy} data-pickup-button>
          {m.markPickedUp}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-6 text-body text-ink-secondary">
        {message}
      </p>
      {problem ? (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
