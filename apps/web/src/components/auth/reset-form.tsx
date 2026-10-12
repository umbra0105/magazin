"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, PasswordInput } from "@ecom/ui";
import { authErrorMessage, authPost } from "@/lib/auth-client";
import { getMessages } from "@/messages";
import { AuthField, describedBy } from "./auth-field";
import { FormAlert } from "./form-alert";

const m = getMessages().auth;
const MAX_PASSWORD = 128;

export function ResetForm({
  token,
  minPasswordLength,
}: {
  token: string;
  minPasswordLength: number;
}) {
  const schema = useMemo(
    () =>
      z.object({
        newPassword: z
          .string()
          .min(minPasswordLength, m.common.passwordMin(minPasswordLength))
          .max(MAX_PASSWORD, m.common.passwordMax(MAX_PASSWORD)),
      }),
    [minPasswordLength],
  );
  type Values = z.infer<typeof schema>;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { newPassword: "" } });

  const [formError, setFormError] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(values: Values) {
    setFormError(null);
    const result = await authPost("/api/auth/reset-password", {
      newPassword: values.newPassword,
      token,
    });
    if (result.ok) {
      setDone(true);
      return;
    }
    setTokenInvalid(result.code === "INVALID_TOKEN");
    setFormError(authErrorMessage(result, "reset", m));
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="success">{m.reset.done}</FormAlert>
        <Link
          href="/autentificare"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {m.common.backToLogin}
        </Link>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      aria-busy={isSubmitting}
      className="flex flex-col gap-4"
    >
      {formError ? <FormAlert tone="error">{formError}</FormAlert> : null}
      {tokenInvalid ? (
        <Link
          href="/recuperare-parola"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {m.reset.requestNew}
        </Link>
      ) : null}

      <AuthField
        id="reset-password"
        label={m.reset.newPassword}
        hint={m.register.passwordHint(minPasswordLength)}
        error={errors.newPassword?.message}
      >
        <PasswordInput
          id="reset-password"
          autoComplete="new-password"
          showLabel={m.common.showPassword}
          hideLabel={m.common.hidePassword}
          aria-invalid={errors.newPassword ? true : undefined}
          aria-describedby={describedBy("reset-password", {
            hint: true,
            error: !!errors.newPassword,
          })}
          {...register("newPassword")}
        />
      </AuthField>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? m.common.submitting : m.reset.submit}
      </Button>
    </form>
  );
}
