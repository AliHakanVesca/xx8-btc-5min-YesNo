const REDACTED = "[redacted]";

let installed = false;

export function redactClobSecretText(value: string): string {
  return value
    .replace(
      /("(?:POLY_API_KEY|POLY_API_SECRET|POLY_API_PASSPHRASE|POLY_PASSPHRASE|POLY_SIGNATURE|signature|owner)"\s*:\s*")([^"]*)(")/gi,
      `$1${REDACTED}$3`,
    )
    .replace(
      /(\\"(?:POLY_API_KEY|POLY_API_SECRET|POLY_API_PASSPHRASE|POLY_PASSPHRASE|POLY_SIGNATURE|signature|owner)\\"\s*:\s*\\")([^\\"]*)(\\")/gi,
      `$1${REDACTED}$3`,
    )
    .replace(
      /((?:POLY_API_KEY|POLY_API_SECRET|POLY_API_PASSPHRASE|POLY_PASSPHRASE|POLY_SIGNATURE|signature|owner)=)([^&\s]+)/gi,
      `$1${REDACTED}`,
    );
}

function redactConsoleArg(arg: unknown): unknown {
  if (typeof arg === "string") {
    return redactClobSecretText(arg);
  }
  return arg;
}

export function installClobConsoleRedaction(): void {
  if (installed) {
    return;
  }
  installed = true;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args.map(redactConsoleArg));
  };
}
