/**
 * Declaración de tipos mínima para el paquete `input`, que no trae tipos
 * propios. Solo se declaran las funciones que usa `scripts/telegram-login.ts`.
 *
 * `input` envuelve a Inquirer con una API chica y basada en promesas para
 * pedir una respuesta por vez desde la terminal.
 */
declare module "input" {
  interface InputOptions {
    /** Respuesta por defecto si el usuario no escribe nada. */
    default?: string;
  }

  /** Pide una línea de texto plano por la terminal. */
  export function text(label?: string, options?: InputOptions): Promise<string>;

  /** Igual que `text`, pero oculta lo tipeado con asteriscos. */
  export function password(
    label?: string,
    options?: InputOptions,
  ): Promise<string>;

  interface Input {
    text: typeof text;
    password: typeof password;
  }

  const input: Input;
  export default input;
}
