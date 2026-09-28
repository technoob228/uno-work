/**
 * /ai in both builds. Lite: the chat itself (no computer here). Full app: the
 * same chat plus "Continue on this computer" — the Uno on the connected
 * computer takes the conversation over.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MonitorUpIcon, LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { balanceQuery } from "../components/myuno/myUnoQueries";
import { Button } from "../components/ui/button";
import { isWebLite } from "../lite/flag";
import { WORK_AI_FEATURE } from "./unoAiApi";
import { useContinueOnComputer } from "./useContinueOnComputer";
import { UnoAiView, type UnoAiSearch } from "./UnoAiView";

export function UnoAiRoute({ search }: { search: UnoAiSearch }) {
  const navigate = useNavigate();
  const balance = useQuery(balanceQuery());
  // Lite before the work_ai rollout: My Uno stays the home.
  const off =
    isWebLite &&
    balance.data !== undefined &&
    !(balance.data.features ?? []).includes(WORK_AI_FEATURE);
  useEffect(() => {
    if (off) void navigate({ to: "/my-uno", replace: true });
  }, [navigate, off]);
  if (off) return null;
  return (
    <UnoAiView
      search={search}
      {...(isWebLite
        ? {}
        : { renderContinueHere: (chatId: string) => <ContinueHere chatId={chatId} /> })}
    />
  );
}

function ContinueHere({ chatId }: { chatId: string }) {
  const { available, run } = useContinueOnComputer();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!available) return null;
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await run(chatId);
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Could not continue here.");
          } finally {
            setBusy(false);
          }
        }}
        data-testid="uno-ai-continue-here"
        title={err ?? "Uno on this computer takes the conversation over"}
      >
        {busy ? <LoaderIcon className="animate-spin" /> : <MonitorUpIcon />}
        Continue on this computer
      </Button>
    </>
  );
}
