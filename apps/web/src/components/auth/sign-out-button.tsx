"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@ecom/ui";
import { authErrorMessage, authPost } from "@/lib/auth-client";
import { getMessages } from "@/messages";
import { FormAlert } from "./form-alert";

const m = getMessages().auth;

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    const result = await authPost("/api/auth/sign-out", {});
    if (result.ok) {
      router.replace("/autentificare");
      router.refresh();
      return;
    }
    setPending(false);
    setError(authErrorMessage(result, "login", m));
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <FormAlert tone="error">{error}</FormAlert> : null}
      <Button type="button" variant="outline" onClick={signOut} disabled={pending}>
        {pending ? m.account.signingOut : m.account.signOut}
      </Button>
    </div>
  );
}
