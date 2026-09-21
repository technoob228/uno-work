/**
 * "For engineers" — closed by default. The technical second layer of the
 * computer, like "About This Mac → System Report": the SSH command, the ports
 * it listens on, the system image. Nothing here is needed to use the computer.
 */
import type { UnoComputerBox } from "@t3tools/contracts";
import { ChevronRightIcon, TerminalSquareIcon } from "lucide-react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { CopyButton } from "./computerUi";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">{children}</dd>
    </div>
  );
}

export function ComputerEngineersDoor({ box }: { box: UnoComputerBox }) {
  return (
    <Collapsible className="rounded-2xl border border-dashed border-border/80">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-3.5 text-left text-sm text-muted-foreground hover:text-foreground">
        <TerminalSquareIcon className="size-4" />
        <span className="font-medium">For engineers</span>
        <span className="text-xs text-muted-foreground/70">SSH, ports, system</span>
        <ChevronRightIcon className="ml-auto size-4 transition-transform group-data-[panel-open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="flex flex-col gap-3 border-t border-dashed border-border/80 px-5 py-4 text-sm">
          <Row label="SSH">
            {box.ssh ? (
              <>
                <code className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {box.ssh}
                </code>
                <CopyButton value={box.ssh} label="SSH command" />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">No SSH endpoint yet</span>
            )}
          </Row>
          <Row label="Ports">
            {box.ports.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {box.ports.map((port) => (
                  <span
                    key={`${port.protocol}:${port.port}`}
                    className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]"
                    title={
                      port.externalPort
                        ? `Port ${port.port} inside, ${port.externalPort} on the public address`
                        : `Port ${port.port}, not published`
                    }
                  >
                    {port.port}/{port.protocol}
                    {port.externalPort ? ` → ${port.externalPort}` : ""}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">None published</span>
            )}
          </Row>
          {box.os ? (
            <Row label="System">
              <span className="font-mono text-xs">{box.os}</span>
            </Row>
          ) : null}
          <Row label="Computer ID">
            <span className="font-mono text-xs">#{box.id}</span>
          </Row>
        </dl>
      </CollapsiblePanel>
    </Collapsible>
  );
}
