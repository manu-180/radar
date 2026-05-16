import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Acceso · Lead Detector",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 p-8">
        <h1 className="text-xl font-semibold">Lead Detector</h1>
        <p className="mt-1 mb-6 text-sm text-zinc-500">
          Ingresá la contraseña para entrar al panel.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
