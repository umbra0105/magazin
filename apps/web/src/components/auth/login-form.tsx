"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, Input, PasswordInput } from "@ecom/ui";
import { authErrorMessage, authPost } from "@/lib/auth-client";
import { getMessages } from "@/messages";
import { AuthField, describedBy } from "./auth-field";
import { FormAlert } from "./form-alert";

const m = getMessages().auth;

export function LoginForm({
  nextPath,
  sessionExpired = false,
  registerHref,
}: {
  /** Destinația după autentificare, deja validată pe server (`safeNextPath`) sau `null`. */
  nextPath: string | null;
  /** Sesiunea de admin a expirat: se afișează „Sesiunea a expirat” deasupra formularului. */
  sessionExpired?: boolean;
  registerHref: string;
}) {
  const router = useRouter();
  const schema = useMemo(
    () =>
      z.object({
        email: z.string().trim().min(1, m.common.required).pipe(z.email(m.common.invalidEmail)),
        // La autentificare nu validăm lungimea: nu dezvăluim politica și nu blocăm conturi vechi.
        password: z.string().min(1, m.common.required),
      }),
    [],
  );
  type Values = z.infer<typeof schema>;
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const [formError, setFormError] = useState<string | null>(null);
  const [notVerified, setNotVerified] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(values: Values) {
    setFormError(null);
    setInfo(null);
    setNotVerified(false);
    const result = await authPost("/api/auth/sign-in/email", values);
    if (result.ok) {
      router.replace(nextPath ?? "/cont");
      router.refresh();
      return;
    }
    setNotVerified(result.code === "EMAIL_NOT_VERIFIED");
    setFormError(authErrorMessage(result, "login", m));
  }

  async function resend() {
    setInfo(null);
    const email = getValues("email").trim();
    const result = await authPost("/api/auth/send-verification-email", {
      email,
      callbackURL: "/verificare-email",
    });
    if (result.ok) {
      setFormError(null);
      setInfo(m.login.resent);
    } else {
      setFormError(authErrorMessage(result, "verify", m));
    }
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      aria-busy={isSubmitting}
      className="flex flex-col gap-4"
    >
      {sessionExpired && !formError ? (
        <FormAlert tone="error" focusOnShow={false}>
          {getMessages().admin.session.expired}
        </FormAlert>
      ) : null}
      {formError ? <FormAlert tone="error">{formError}</FormAlert> : null}
      {info ? <FormAlert tone="success">{info}</FormAlert> : null}

      <AuthField id="login-email" label={m.common.email} error={errors.email?.message}>
        <Input
          id="login-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy("login-email", { error: !!errors.email })}
          {...register("email")}
        />
      </AuthField>

      <AuthField id="login-password" label={m.common.password} error={errors.password?.message}>
        <PasswordInput
          id="login-password"
          autoComplete="current-password"
          showLabel={m.common.showPassword}
          hideLabel={m.common.hidePassword}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={describedBy("login-password", { error: !!errors.password })}
          {...register("password")}
        />
      </AuthField>

      {notVerified ? (
        <Button type="button" variant="outline" onClick={resend}>
          {m.login.resend}
        </Button>
      ) : null}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? m.common.submitting : m.login.submit}
      </Button>

      <div className="flex flex-col gap-2 text-sm">
        <Link href="/recuperare-parola" className="text-primary underline-offset-4 hover:underline">
          {m.login.forgot}
        </Link>
        <p className="text-muted-foreground">
          {m.login.noAccount}{" "}
          <Link href={registerHref} className="text-primary underline-offset-4 hover:underline">
            {m.login.register}
          </Link>
        </p>
      </div>
    </form>
  );
}
