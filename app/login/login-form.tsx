"use client";

import { useActionState } from "react";

import { type LoginState, login } from "./actions";

const INITIAL_STATE: LoginState = {};

/** Formulario de acceso: un campo de contraseña conectado a la server action. */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="password" className="text-sm font-medium text-zinc-700">
        Contraseña
      </label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autoFocus
        autoComplete="current-password"
        aria-describedby={state.error ? "password-error" : undefined}
        className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
      />
      {state.error && (
        <p id="password-error" role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
      >
        {pending ? "Verificando…" : "Entrar"}
      </button>
    </form>
  );
}
