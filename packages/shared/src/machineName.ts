/**
 * Names a computer has only for us, never for the person.
 *
 * An Uno Work computer is restored from a memory snapshot of its image: the
 * daemon first wakes up on the image's warm VM, whose hostname is the image's
 * service name (`img-208-warm`), and gets its own name from the guest agent a
 * moment later. Whatever read the hostname in between showed "Runs on
 * img-208-warm" to the person (validator, 03.10.2026).
 */
const SERVICE_MACHINE_NAMES: ReadonlyArray<RegExp> = [
  /^img-\d+(?:-[a-z0-9]+)*$/i,
  /^uno-?work-golden(?:-[a-z0-9.]+)*$/i,
];

/** `img-208-warm`, `uno-work-golden-v53-build`: an image's name, not a computer's. */
export function isServiceMachineName(name: string | null | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  return SERVICE_MACHINE_NAMES.some((pattern) => pattern.test(trimmed));
}

/** The name as the person knows it, or null when it is empty or a service name. */
export function personMachineName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || isServiceMachineName(trimmed)) return null;
  return trimmed;
}
