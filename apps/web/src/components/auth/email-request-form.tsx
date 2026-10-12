"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, Input } from "@ecom/ui";
import { authErrorMessage, authPost, type AuthContext } from "@/lib/auth-client";
import { getMessages } from "@/messages";
import { AuthField, describedBy } from "./auth-field";
import { FormAlert } from "./form-alert";

const m = getMessages().auth;

/**
 * Formular cu un singur câmp (email), folosit la „am uitat parola” și la retrimiterea verificării.
 * Răspunsul de succes e același indiferent dacă există sau nu un cont (fără enumerare).
 */
export function EmailRequestForm({
  endpoint,
  body,
  context,
  submitLabel,
  successMessage,
  idPrefix,
}: {
  endpoint: string;
  /** Câmpurile fixe trimise împreună cu emailul (ex. `redirectTo`, `callbackURL`). */
  body: Record<string, string>;
  context: AuthContext;
  submitLabel: string;
  successMessage: string;
  idPrefix: string;
}) {
  const schema = useMemo(
    () =>
      z.object({
        email: z.string().trim().min(1, m.common.required).pipe(z.email(m.common.invalidEmail)),
      }),
    [],
  );
  type Values = z.infer<typeof schema>;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(values: Values) {
    setFormError(null);
    const result = await authPost(endpoint, { ...body, email: values.email });
    if (result.ok) {
      setSent(true);
      return;
    }
    setFormError(authErrorMessage(result, context, m));
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="success">{successMessage}</FormAlert>
        <Link
          href="/autentificare"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {m.common.backToLogin}
        </Link>
      </div>
    );
  }

  const id = `${idPrefix}-email`;
  return (
    <form
      method="post"
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      aria-busy={isSubmitting}
      className="flex flex-col gap-4"
    >
      {formError ? <FormAlert tone="error">{formError}</FormAlert> : null}
      <AuthField id={id} label={m.common.email} error={errors.email?.message}>
        <Input
          id={id}
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy(id, { error: !!errors.email })}
          {...register("email")}
        />
      </AuthField>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? m.common.submitting : submitLabel}
      </Button>
      <Link
        href="/autentificare"
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        {m.common.backToLogin}
      </Link>
    </form>
  );
}
