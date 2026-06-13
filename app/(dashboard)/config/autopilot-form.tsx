"use client";

/**
 * Formulario del Autopilot.
 *
 * Isla de cliente con varias secciones:
 *  - **Kill-switch maestro** (`outreach_enabled`): se togglea solo, con su propia
 *    acción, y muestra un indicador grande ON/OFF + advertencia de que ON =
 *    contacto automático.
 *  - **Autopilot por canal**, **regla de enganche** (categorías + score),
 *    **tope diario**, **tope de mensajes del agente** y **política de follow-ups**
 *    (lista de esperas en horas + máximo): se guardan juntos con `updateAutopilot`.
 */

import { useState, useTransition } from "react";

import type { Channel } from "@/types/autopilot";

import {
  type AutopilotInput,
  setOutreachEnabled,
  updateAutopilot,
} from "./autopilot-actions";

import { FIELD_CLASS, PRIMARY_BTN, SECONDARY_BTN } from "../ui";

/** Canales conocidos, con su rótulo legible. */
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "telegram", label: "Telegram" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "bluesky", label: "Bluesky" },
  { value: "reddit", label: "Reddit" },
];

/** Categorías de lead que pueden disparar el enganche. */
const CATEGORIES: { value: string; label: string }[] = [
  { value: "hiring", label: "Hiring" },
  { value: "maybe", label: "Maybe" },
  { value: "noise", label: "Noise" },
];

/** Switch accesible reutilizable. */
function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-ring disabled:opacity-60 ${
        checked ? "bg-[var(--ok-solid)]" : "bg-[var(--border-strong)]"
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** Sección del master kill-switch: indicador grande + advertencia + toggle. */
function MasterSwitch({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await setOutreachEnabled(next);
      if (!result.ok) {
        setOn(!next);
        setError(result.error ?? "No se pudo cambiar el estado.");
      }
    });
  }

  return (
    <div
      className={`rounded-xl border p-5 transition-colors ${
        on
          ? "border-[var(--ok-solid)]/40 bg-[var(--ok-soft)]/40"
          : "border-[var(--border-strong)] bg-[var(--surface-2)]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-12 w-12 items-center justify-center rounded-xl ${
              on
                ? "bg-[var(--ok-solid)] text-white"
                : "bg-[var(--border-strong)] text-[var(--surface)]"
            }`}
            aria-hidden
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              {on ? (
                <path d="M5 12.5 9.5 17 19 7" />
              ) : (
                <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64M12 2v10" />
              )}
            </svg>
          </span>
          <div>
            <p className="text-sm font-medium text-[var(--muted)]">
              Outreach automático
            </p>
            <p
              className={`text-2xl font-semibold tracking-tight ${
                on ? "text-[var(--ok-soft-fg)]" : "text-[var(--foreground)]"
              }`}
            >
              {on ? "ACTIVADO" : "APAGADO"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--muted)]">
            {on ? "Contactando" : "En pausa"}
          </span>
          <Switch
            checked={on}
            onChange={toggle}
            disabled={pending}
            label="Interruptor maestro de outreach"
          />
        </div>
      </div>

      <p
        className={`mt-3 flex items-start gap-2 text-sm ${
          on ? "text-[var(--warn-soft-fg)]" : "text-[var(--muted)]"
        }`}
      >
        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
          <path d="M12 9v4M12 17h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {on
          ? "Con esto activado, el sistema le escribe primero a la gente de forma automática. Apagalo para frenar todo el contacto saliente al instante."
          : "Mientras esté apagado, no se inicia ningún contacto nuevo. Las conversaciones en curso siguen visibles, pero el sistema no arranca charlas nuevas."}
      </p>

      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--danger-soft-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** Editor de la lista de esperas (en horas) de la política de follow-ups. */
function DelaysEditor({
  delays,
  onChange,
}: {
  delays: number[];
  onChange: (next: number[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {delays.map((h, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] py-1 pl-2.5 pr-1.5 text-sm"
          >
            <input
              type="number"
              min={0}
              step={1}
              value={Number.isFinite(h) ? h : 0}
              onChange={(e) => {
                const next = [...delays];
                next[i] = Number(e.target.value);
                onChange(next);
              }}
              aria-label={`Espera ${i + 1} en horas`}
              className="w-16 bg-transparent text-right tabular-nums focus:outline-none"
            />
            <span className="text-xs text-[var(--muted)]">h</span>
            <button
              type="button"
              onClick={() => onChange(delays.filter((_, j) => j !== i))}
              aria-label={`Quitar espera ${i + 1}`}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--subtle)] hover:bg-[var(--surface-2)] hover:text-[var(--danger-soft-fg)] focus-ring"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => onChange([...delays, 24])}
          className="inline-flex items-center gap-1 rounded-lg border border-dashed border-[var(--border-strong)] px-2.5 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface-2)] focus-ring"
        >
          + Espera
        </button>
      </div>
      <p className="text-xs text-[var(--subtle)]">
        Cada valor es cuántas horas esperar antes del próximo follow-up. El
        último se reutiliza si quedan follow-ups por mandar.
      </p>
    </div>
  );
}

export function AutopilotForm({
  outreachEnabled,
  channelAutopilot,
  engageRule,
  outreachDailyCap,
  agentMaxMessages,
  followupPolicy,
}: {
  outreachEnabled: boolean;
  channelAutopilot: Record<Channel, boolean>;
  engageRule: { categories: string[]; minScore: number };
  outreachDailyCap: number;
  agentMaxMessages: number;
  followupPolicy: { delaysHours: number[]; maxFollowups: number };
}) {
  const [channels, setChannels] =
    useState<Record<Channel, boolean>>(channelAutopilot);
  const [categories, setCategories] = useState<string[]>(engageRule.categories);
  const [minScore, setMinScore] = useState(String(engageRule.minScore));
  const [dailyCap, setDailyCap] = useState(String(outreachDailyCap));
  const [maxMessages, setMaxMessages] = useState(String(agentMaxMessages));
  const [delays, setDelays] = useState<number[]>(followupPolicy.delaysHours);
  const [maxFollowups, setMaxFollowups] = useState(
    String(followupPolicy.maxFollowups),
  );

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function touch() {
    setSaved(false);
    setError(null);
  }

  function toggleCategory(cat: string) {
    touch();
    setCategories((cs) =>
      cs.includes(cat) ? cs.filter((c) => c !== cat) : [...cs, cat],
    );
  }

  function handleSave() {
    setError(null);
    setSaved(false);

    if (categories.length === 0) {
      setError("Elegí al menos una categoría para el enganche.");
      return;
    }

    const payload: AutopilotInput = {
      channelAutopilot: channels,
      engageRule: {
        categories,
        minScore: Number(minScore),
      },
      outreachDailyCap: Number(dailyCap),
      agentMaxMessages: Number(maxMessages),
      followupPolicy: {
        delaysHours: delays,
        maxFollowups: Number(maxFollowups),
      },
    };

    startTransition(async () => {
      const result = await updateAutopilot(payload);
      if (result.ok) setSaved(true);
      else setError(result.error ?? "No se pudo guardar la configuración.");
    });
  }

  return (
    <div className="space-y-6">
      <MasterSwitch initial={outreachEnabled} />

      <div className="space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        {/* Autopilot por canal */}
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              Autopilot por canal
            </h3>
            <p className="text-xs text-[var(--muted)]">
              Si un canal está apagado, el agente no responde solo en ese canal
              (los mensajes te quedan para responder a mano).
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHANNELS.map((ch) => (
              <div
                key={ch.value}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2.5"
              >
                <span className="text-sm font-medium text-[var(--foreground)]">
                  {ch.label}
                </span>
                <Switch
                  checked={channels[ch.value]}
                  onChange={(v) => {
                    touch();
                    setChannels((c) => ({ ...c, [ch.value]: v }));
                  }}
                  label={`Autopilot en ${ch.label}`}
                />
              </div>
            ))}
          </div>
        </section>

        {/* Regla de enganche */}
        <section className="space-y-3 border-t border-[var(--border)] pt-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              Regla de enganche
            </h3>
            <p className="text-xs text-[var(--muted)]">
              Qué leads ameritan un primer contacto: categorías elegidas y score
              mínimo.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const active = categories.includes(cat.value);
              return (
                <button
                  key={cat.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleCategory(cat.value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-ring ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]"
                      : "border-[var(--border-strong)] text-[var(--muted)] hover:bg-[var(--surface-2)]"
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--foreground)]">
              Score mínimo
            </span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={minScore}
              onChange={(e) => {
                touch();
                setMinScore(e.target.value);
              }}
              aria-label="Score mínimo para enganchar"
              className={`${FIELD_CLASS} w-28`}
            />
            <span className="text-xs text-[var(--subtle)]">
              Un entero de 0 a 100. Sólo se engancha por encima de este score.
            </span>
          </label>
        </section>

        {/* Topes */}
        <section className="grid gap-4 border-t border-[var(--border)] pt-5 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--foreground)]">
              Tope de contactos por día
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={dailyCap}
              onChange={(e) => {
                touch();
                setDailyCap(e.target.value);
              }}
              aria-label="Tope de primeros contactos por día"
              className={`${FIELD_CLASS} w-28`}
            />
            <span className="text-xs text-[var(--subtle)]">
              Límite anti-ban de primeros contactos automáticos por día.
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--foreground)]">
              Tope de mensajes del agente
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={maxMessages}
              onChange={(e) => {
                touch();
                setMaxMessages(e.target.value);
              }}
              aria-label="Tope de mensajes del agente antes del handoff"
              className={`${FIELD_CLASS} w-28`}
            />
            <span className="text-xs text-[var(--subtle)]">
              Pasados estos mensajes sin cierre, el agente te deriva el lead.
            </span>
          </label>
        </section>

        {/* Política de follow-ups */}
        <section className="space-y-3 border-t border-[var(--border)] pt-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              Política de follow-ups
            </h3>
            <p className="text-xs text-[var(--muted)]">
              Cuánto esperar entre reenganches y cuántos mandar como máximo.
            </p>
          </div>
          <DelaysEditor
            delays={delays}
            onChange={(next) => {
              touch();
              setDelays(next);
            }}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--foreground)]">
              Máximo de follow-ups
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={maxFollowups}
              onChange={(e) => {
                touch();
                setMaxFollowups(e.target.value);
              }}
              aria-label="Máximo de follow-ups"
              className={`${FIELD_CLASS} w-28`}
            />
            <span className="text-xs text-[var(--subtle)]">
              Cuántos reenganches automáticos como mucho antes de marcar perdido.
            </span>
          </label>
        </section>

        {/* Guardar */}
        <div className="flex items-center gap-3 border-t border-[var(--border)] pt-5">
          <button
            type="button"
            disabled={pending}
            onClick={handleSave}
            className={PRIMARY_BTN}
          >
            {pending ? "Guardando…" : "Guardar autopilot"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              touch();
              setChannels(channelAutopilot);
              setCategories(engageRule.categories);
              setMinScore(String(engageRule.minScore));
              setDailyCap(String(outreachDailyCap));
              setMaxMessages(String(agentMaxMessages));
              setDelays(followupPolicy.delaysHours);
              setMaxFollowups(String(followupPolicy.maxFollowups));
            }}
            className={SECONDARY_BTN}
          >
            Descartar cambios
          </button>
          {saved && (
            <span className="text-sm text-[var(--ok-soft-fg)]">Guardado ✓</span>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--danger-soft-fg)]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
