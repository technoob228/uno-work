import { useServerProviders } from "~/rpc/serverState";
import { HarnessSetupList } from "../../../harness/HarnessSetupList";
import { StepEyebrow, StepLead, StepTitle } from "../stepShared";

export function WebHarnessesStep() {
  const providers = useServerProviders();

  return (
    <div className="flex flex-1 flex-col">
      <StepEyebrow>Harnesses</StepEyebrow>
      <StepTitle>Pick the agents you want</StepTitle>
      <StepLead>
        Uno, OpenCode and Hermes come with your machine, already authenticated through the Uno
        gateway. Claude Code, Codex and Cursor run on your own subscriptions — install them here
        with one click, then sign in.
      </StepLead>

      <div className="mt-8 max-w-xl">
        <HarnessSetupList providers={providers} />
      </div>

      <p className="mt-4 max-w-xl text-xs text-muted-foreground">
        Installs run on your machine as your own user — no terminal needed. Once a harness is ready
        it shows up in the model picker automatically; no restart.
      </p>
    </div>
  );
}
