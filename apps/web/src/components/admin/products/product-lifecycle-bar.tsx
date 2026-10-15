"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@ecom/ui";
import { duplicateProduct } from "@/app/(admin)/admin/produse/lifecycle-actions";
import { getMessages } from "@/messages";
import {
  LifecycleConfirmDialog,
  lifecycleErrorText,
  type LifecycleOperation,
} from "./lifecycle-dialogs";

const m = getMessages().admin.products;
const l = m.lifecycle;

/**
 * Acțiunile ciclului de viață din pagina produsului: duplică, arhivează / dezarhivează, mută în
 * coșul de gunoi. Apar doar cu `products.write` (serverul o cere oricum la fiecare acțiune).
 */
export function ProductLifecycleBar({
  productId,
  title,
  status,
}: {
  productId: string;
  title: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [operation, setOperation] = useState<LifecycleOperation | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const archived = status === "archived";

  const duplicate = () => {
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await duplicateProduct({ id: productId });
        if (result.ok) {
          router.push(`/admin/produse/${result.id}?copied=1&docs=${result.skipped.documents}`);
        } else {
          setProblem(lifecycleErrorText(result));
        }
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <div className="flex flex-col gap-2" data-lifecycle-actions>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div role="group" aria-label={l.group} className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={duplicate} data-duplicate>
          {pending ? l.duplicating : l.duplicate}
        </Button>
        {archived ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setOperation("unarchive")}
          >
            {l.actions.unarchive}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setOperation("archive")}
          >
            {l.actions.archive}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setOperation("delete")}
        >
          {l.actions.delete}
        </Button>
      </div>
      {problem && (
        <p role="alert" data-problem className="text-sm text-danger">
          {problem}
        </p>
      )}
      <LifecycleConfirmDialog
        operation={operation ?? "archive"}
        products={[{ id: productId, title }]}
        open={operation !== null}
        onClose={() => setOperation(null)}
        onDone={(count) => {
          const done = operation;
          setOperation(null);
          if (done === "delete") {
            // produsul șters nu mai are pagină de editare: înapoi la listă
            router.push("/admin/produse");
          } else {
            setAnnouncement(l.done[done ?? "archive"](count));
            router.refresh();
          }
        }}
      />
    </div>
  );
}
