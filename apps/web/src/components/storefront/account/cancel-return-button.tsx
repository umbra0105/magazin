"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog, StoreButton } from "@ecom/ui";
import { cancelReturnAction } from "@/app/(storefront)/cont/actions";
import { getMessages } from "@/messages";

const m = getMessages().account.returns;

/** Anularea returului de către client (cât timp e «cerut» sau «aprobat»), cu un dialog propriu de confirmare. */
export function CancelReturnButton({ returnId }: { returnId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const result = await cancelReturnAction({ returnId });
      if (result.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setError(m.errors[result.code] ?? m.errors["failed"] ?? "");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <StoreButton type="button" variant="secondary" onClick={() => setOpen(true)}>
          {m.cancel}
        </StoreButton>
      </div>
      <p role="alert" className="min-h-6 text-tone-problem-fg">
        {error}
      </p>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={m.cancelTitle}
        description={m.cancelText}
        closeLabel={getMessages().account.common.close}
      >
        <div className="flex flex-wrap justify-end gap-3">
          <StoreButton type="button" variant="secondary" onClick={() => setOpen(false)}>
            {m.cancelNo}
          </StoreButton>
          <StoreButton type="button" onClick={run} disabled={pending} data-cancel-confirm>
            {m.cancelYes}
          </StoreButton>
        </div>
      </Dialog>
    </div>
  );
}
