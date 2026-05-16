"use client";

/**
 * Controles interactivos de las secciones de **fuentes** y **ajustes
 * generales** del panel de Configuración.
 *
 * Client Components porque necesitan estado de edición y de carga. Cada uno
 * llama a una server action de `./source-actions`, que valida y persiste el
 * cambio y revalida `/config`. La página remonta cada control con su valor
 * fresco (vía `key`) tras un guardado exitoso, así el editor refleja siempre
 * lo que quedó en la base.
 */

import { useState, useTransition } from "react";

import {
  type ConfigResult,
  toggleSource,
  updateFreelancerProfile,
  updateMaxNotifications,
  updateNotifyRule,
  updateSourceConfig,
} from "./source-actions";

/** Una fuente tal como la página la pasa para mostrarla y editarla. */
export interface Source {
  slug: string;
  name: string;
  enabled: boolean;
  /** `true` si hay un adaptador registrado para el `slug` (valida el config). */
  hasAdapter: boolean;
  /** Config propio de la fuente (columna `sources.config`). */
  config: unknown;
}

/** Clases compartidas de inputs y textareas. */
const FIELD_CLASS = "rounded-md border border-zinc-300 px-2 py-1.5 text-sm";
/** Clases del editor de texto monoespaciado para JSON. */
const CODE_CLASS = `${FIELD_CLASS} w-full font-mono text-xs leading-relaxed`;
/** Clases del botón primario (guardar). */
const PRIMARY_BTN =
  "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60";
/** Clases del botón secundario (toggle). */
const SECONDARY_BTN =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60";

/** Serializa un valor JSON con sangría, listo para mostrar en un editor. */
function pretty(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

/**
 * Fila editable de una fuente: la activa o desactiva y reescribe su `config`
 * desde un editor de texto JSON.
 *
 * El `config` se valida en el server contra el `configSchema` del adaptador;
 * si no pasa, la acción devuelve el error y se muestra acá sin guardar nada.
 */
export function SourceRow({ source }: { source: Source }) {
  const initial = pretty(source.config);
  const [configText, setConfigText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = configText !== initial;

  /** Corre una server action y muestra su error si falla. */
  function run(action: () => Promise<ConfigResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar la acción.");
      }
    });
  }

  return (
    <li className="space-y-3 rounded-md border border-zinc-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900">{source.name}</span>
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">
          {source.slug}
        </code>

        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            source.enabled
              ? "bg-green-100 text-green-800"
              : "bg-zinc-100 text-zinc-500"
          }`}
        >
          {source.enabled ? "Activa" : "Inactiva"}
        </span>

        {!source.hasAdapter && (
          <span
            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
            title="Sin adaptador registrado: el config no se valida contra un schema."
          >
            Sin adaptador
          </span>
        )}

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => toggleSource(source.slug, !source.enabled))}
          className={`${SECONDARY_BTN} ml-auto`}
        >
          {source.enabled ? "Desactivar" : "Activar"}
        </button>
      </div>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Config (JSON)
        <textarea
          value={configText}
          onChange={(event) => setConfigText(event.target.value)}
          spellCheck={false}
          rows={Math.min(16, Math.max(4, initial.split("\n").length))}
          aria-label={`Config de la fuente ${source.name}`}
          className={CODE_CLASS}
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !dirty}
          onClick={() => run(() => updateSourceConfig(source.slug, configText))}
          className={PRIMARY_BTN}
        >
          Guardar config
        </button>
        {dirty && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setConfigText(initial);
              setError(null);
            }}
            className={SECONDARY_BTN}
          >
            Descartar
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Editor de la regla de notificación (`settings.notify_rule`).
 *
 * Es un editor de texto JSON con la forma `{ categories, minScore }`; el server
 * valida el contenido contra un schema de Zod antes de persistir.
 */
export function NotifyRuleForm({ rule }: { rule: unknown }) {
  const initial = pretty(rule);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = text !== initial;

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateNotifyRule(text);
      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar la regla.");
      }
    });
  }

  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Regla de notificación (JSON)
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={5}
          aria-label="Regla de notificación"
          className={CODE_CLASS}
        />
      </label>
      <p className="text-xs text-zinc-400">
        Categorías válidas: <code>hiring</code>, <code>maybe</code>,{" "}
        <code>noise</code>. <code>minScore</code> es un entero de 0 a 100.
      </p>
      <button
        type="button"
        disabled={pending || !dirty}
        onClick={handleSave}
        className={PRIMARY_BTN}
      >
        Guardar regla
      </button>
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/** Editor del tope de avisos por corrida (`settings.max_notifications_per_run`). */
export function MaxNotificationsForm({ value }: { value: number }) {
  const [raw, setRaw] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = raw.trim() !== String(value);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateMaxNotifications(Number(raw));
      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar el tope.");
      }
    });
  }

  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Máximo de avisos por corrida
        <input
          type="number"
          min={1}
          step={1}
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          aria-label="Máximo de avisos por corrida"
          className={`${FIELD_CLASS} w-32`}
        />
      </label>
      <button
        type="button"
        disabled={pending || !dirty}
        onClick={handleSave}
        className={PRIMARY_BTN}
      >
        Guardar tope
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/** Editor del perfil del freelancer (`settings.freelancer_profile`). */
export function FreelancerProfileForm({ profile }: { profile: string }) {
  const [text, setText] = useState(profile);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = text !== profile;

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateFreelancerProfile(text);
      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar el perfil.");
      }
    });
  }

  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Perfil del freelancer
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          placeholder="Bio que la IA usa para personalizar las respuestas sugeridas."
          aria-label="Perfil del freelancer"
          className={`${FIELD_CLASS} w-full`}
        />
      </label>
      <button
        type="button"
        disabled={pending || !dirty || !text.trim()}
        onClick={handleSave}
        className={PRIMARY_BTN}
      >
        Guardar perfil
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
