import Link from "next/link";
import { buttonVariants, EmptyState } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().states.notFound;

/** 404 în admin: apare în cadrul adminului (meniul rămâne), cu o singură acțiune. */
export default function AdminNotFound() {
  return (
    <EmptyState
      as="h2"
      title={m.title}
      description={m.description}
      action={
        <Link href="/admin" className={buttonVariants()}>
          {m.admin}
        </Link>
      }
    />
  );
}
