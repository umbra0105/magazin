"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StoreButton } from "@ecom/ui";
import { authPost } from "@/lib/auth-client";
import { getMessages } from "@/messages";

const m = getMessages().account.nav;

/** Deconectarea din contul clientului (vitrina): aceeași rută de autentificare ca în rest, cu butonul vitrinei. */
export function AccountSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    const result = await authPost("/api/auth/sign-out", {});
    if (result.ok) {
      router.replace("/");
      router.refresh();
      return;
    }
    setPending(false);
  }
  return (
    <StoreButton type="button" variant="secondary" onClick={signOut} disabled={pending}>
      {m.signOut}
    </StoreButton>
  );
}
