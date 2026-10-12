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
const MAX_PASSWORD = 128;

export function RegisterForm({
  nextPath,
  minPasswordLength,
  requireEmailVerification,
  loginHref,
}: {
  nextPath: string | null;
  minPasswordLength: number;
  requireEmailVerification: boolean;
  loginHref: string;
}) {
  const router = useRouter();
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, m.common.required).max(100),
        email: z.string().trim().min(1, m.common.required).pipe(z.email(m.common.invalidEmail)),
        password: z
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
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const [formError, setFormError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  async function onSubmit(values: Values) {
    setFormError(null);
    const result = await authPost("/api/auth/sign-up/email", {
      ...values,
      callbackURL: "/verificare-email",
    });
    if (!result.ok) {
      setFormError(authErrorMessage(result, "register", m));
      return;
    }
    if (requireEmailVerification) {
      setCheckEmail(true);
      return;
    }
    router.replace(nextPath ?? "/cont");
    router.refresh();
  }

  if (checkEmail) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{m.register.checkEmailTitle}</h2>
        <FormAlert tone="success">{m.register.checkEmail}</FormAlert>
        <Link href={loginHref} className="text-sm text-primary underline-offset-4 hover:underline">
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

      <AuthField id="register-name" label={m.common.name} error={errors.name?.message}>
        <Input
          id="register-name"
          autoComplete="name"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy("register-name", { error: !!errors.name })}
          {...register("name")}
        />
      </AuthField>

      <AuthField id="register-email" label={m.common.email} error={errors.email?.message}>
        <Input
          id="register-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy("register-email", { error: !!errors.email })}
          {...register("email")}
        />
      </AuthField>

      <AuthField
        id="register-password"
        label={m.common.password}
        hint={m.register.passwordHint(minPasswordLength)}
        error={errors.password?.message}
      >
        <PasswordInput
          id="register-password"
          autoComplete="new-password"
          showLabel={m.common.showPassword}
          hideLabel={m.common.hidePassword}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={describedBy("register-password", {
            hint: true,
            error: !!errors.password,
          })}
          {...register("password")}
        />
      </AuthField>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? m.common.submitting : m.register.submit}
      </Button>

      <p className="text-sm text-muted-foreground">
        {m.register.haveAccount}{" "}
        <Link href={loginHref} className="text-primary underline-offset-4 hover:underline">
          {m.register.login}
        </Link>
      </p>
    </form>
  );
}
