/**
 * Network → Proxy (26.11, Misha: "add a proxy to the VPN feature, so it can
 * be set up in the app's environment"): the person's own HTTP / HTTPS /
 * SOCKS5 proxy for everything Uno Work starts on this computer. The form
 * inside the Network panel: type, address, optional login, "Skip for",
 * Check (the address sites see through it) and Use / Remove.
 *
 * The password goes to the daemon only: the form never gets it back
 * ("Saved" stands in for it), and the daemon keeps it in its secret store.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMutation } from "@tanstack/react-query";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { cn } from "../../lib/utils";
import {
  type NetworkProxyCheck,
  type NetworkProxyInfo,
  type NetworkProxyInput,
  type NetworkProxyScheme,
  checkNetworkProxy,
  flagOf,
  networkErrorMessage,
} from "../../lib/networkApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const SCHEMES: ReadonlyArray<{ value: NetworkProxyScheme; label: string; port: number }> = [
  { value: "http", label: "HTTP", port: 8080 },
  { value: "https", label: "HTTPS", port: 443 },
  { value: "socks5", label: "SOCKS5", port: 1080 },
];

const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

/** "Germany" from "DE"; the code itself where the browser can't name it. */
export function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return regionNames?.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** "🇩🇪 203.0.113.9 · Germany · 120 ms" — what the last check saw. */
export function ProxyCheckLine(props: { check: NetworkProxyCheck | null; checking: boolean }) {
  const { check, checking } = props;
  if (checking) {
    return (
      <p
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        data-testid="network-proxy-check"
        data-check="checking"
      >
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Checking through the proxy…
      </p>
    );
  }
  if (!check) return null;
  if (check.status === "failed") {
    return (
      <p
        className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive-foreground"
        data-testid="network-proxy-check"
        data-check="failed"
      >
        <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
        {check.reason}
      </p>
    );
  }
  const country = countryName(check.country);
  return (
    <p
      className="text-[11px] text-muted-foreground"
      data-testid="network-proxy-check"
      data-check="ok"
    >
      Sites see{" "}
      <span className="font-mono font-medium text-foreground">
        {flagOf(check.country)} {check.ip}
      </span>
      {country ? ` · ${country}` : null} · {check.latencyMs} ms
    </p>
  );
}

const FIELD_LABEL = "mb-1 block text-[11px] font-medium text-muted-foreground";

export function ProxyForm(props: {
  environmentId: EnvironmentId;
  saved: NetworkProxyInfo | null;
  /** Network is on through this proxy right now. */
  active: boolean;
  busy: boolean;
  error: string | null;
  onUse: (proxy: NetworkProxyInput) => void;
  onRemove: () => void;
}) {
  const { saved } = props;
  const [scheme, setScheme] = useState<NetworkProxyScheme>(saved?.scheme ?? "http");
  const [host, setHost] = useState(saved?.host ?? "");
  const [port, setPort] = useState(saved ? String(saved.port) : "");
  const [username, setUsername] = useState(saved?.username ?? "");
  const [password, setPassword] = useState<string | null>(null);
  const [skip, setSkip] = useState(saved?.skip.join(", ") ?? "");
  const [checked, setChecked] = useState<NetworkProxyCheck | null>(saved?.check ?? null);

  const defaultPort = SCHEMES.find((item) => item.value === scheme)?.port ?? 8080;
  const portNumber = port.trim() === "" ? defaultPort : Number(port);
  // The saved password stays unless the person types another (or the proxy changes).
  const keepsPassword =
    saved?.hasPassword === true &&
    password === null &&
    saved.host === host.trim() &&
    saved.port === portNumber &&
    (saved.username ?? "") === username.trim();
  const input: NetworkProxyInput = {
    scheme,
    host: host.trim(),
    port: portNumber,
    ...(username.trim() ? { username: username.trim() } : {}),
    ...(password !== null ? { password } : keepsPassword ? {} : { password: "" }),
    skip: skip.trim() ? [skip] : [],
  };
  const ready = input.host.length > 0 && Number.isInteger(portNumber) && portNumber > 0;

  const check = useMutation({
    mutationFn: () => checkNetworkProxy({ environmentId: props.environmentId, proxy: input }),
    onSuccess: setChecked,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !props.busy) props.onUse(input);
  };

  return (
    <form
      className="flex flex-col gap-2.5 px-3 pt-2.5"
      onSubmit={submit}
      data-testid="network-proxy"
    >
      <p className="text-[11px] leading-snug text-muted-foreground">
        Agents, terminals and the apps Uno Work starts on this computer go online through it.
      </p>
      <div>
        <span className={FIELD_LABEL}>Type</span>
        <ToggleGroup
          variant="outline"
          size="xs"
          value={[scheme]}
          aria-label="Proxy type"
          data-testid="network-proxy-scheme"
          onValueChange={(value) => {
            const next = SCHEMES.find((item) => item.value === value[0]);
            if (next) setScheme(next.value);
          }}
        >
          {SCHEMES.map((item) => (
            <Toggle key={item.value} value={item.value} className="px-2.5 text-xs">
              {item.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className={FIELD_LABEL}>Host</span>
          <Input
            size="sm"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="proxy.example.com"
            autoComplete="off"
            spellCheck={false}
            data-testid="network-proxy-host"
          />
        </label>
        <label className="w-20 shrink-0">
          <span className={FIELD_LABEL}>Port</span>
          <Input
            size="sm"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
            placeholder={String(defaultPort)}
            inputMode="numeric"
            data-testid="network-proxy-port"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className={FIELD_LABEL}>Login</span>
          <Input
            size="sm"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Optional"
            autoComplete="off"
            spellCheck={false}
            data-testid="network-proxy-username"
          />
        </label>
        <label className="min-w-0 flex-1">
          <span className={FIELD_LABEL}>Password</span>
          <Input
            size="sm"
            type="password"
            value={password ?? ""}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={keepsPassword ? "Saved" : "Optional"}
            autoComplete="new-password"
            data-testid="network-proxy-password"
          />
        </label>
      </div>
      <label>
        <span className={FIELD_LABEL}>Skip for</span>
        <Input
          size="sm"
          value={skip}
          onChange={(event) => setSkip(event.target.value)}
          placeholder="*.corp.example, 10.0.0.0/8"
          autoComplete="off"
          spellCheck={false}
          data-testid="network-proxy-skip"
        />
        <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
          Always direct: this computer, your local network and Uno, so Uno can help if the proxy
          breaks.
        </span>
      </label>

      <ProxyCheckLine check={checked} checking={check.isPending} />
      {check.isError ? (
        <p className="text-[11px] text-destructive-foreground">
          {networkErrorMessage(check.error)}
        </p>
      ) : null}
      {props.error ? (
        <p className="text-[11px] text-destructive-foreground" data-testid="network-proxy-error">
          {props.error}
        </p>
      ) : null}

      <div className={cn("flex items-center gap-2 pb-0.5")}>
        <Button
          type="submit"
          size="xs"
          disabled={!ready || props.busy}
          data-testid="network-proxy-use"
        >
          {props.busy ? <LoaderCircleIcon className="animate-spin" /> : null}
          {props.active ? "Save" : "Use this proxy"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!ready || check.isPending}
          onClick={() => check.mutate()}
          data-testid="network-proxy-check-button"
        >
          Check
        </Button>
        {saved ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            disabled={props.busy}
            onClick={props.onRemove}
            data-testid="network-proxy-remove"
          >
            Remove
          </Button>
        ) : null}
      </div>
    </form>
  );
}
