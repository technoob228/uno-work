import { useServerProviders } from "~/rpc/serverState";
import { plainExplanation } from "../../../../plainLanguage";
import { Explain } from "../../../Explain";
import { HarnessSetupList } from "../../../harness/HarnessSetupList";
import { StepEyebrow, StepLead, StepTitle } from "../stepShared";

export function WebHarnessesStep() {
  const providers = useServerProviders();

  return (
    <div className="flex flex-1 flex-col">
      <StepEyebrow>Agents</StepEyebrow>
      <StepTitle>
        <span className="inline-flex items-center gap-3">
          Pick the agents you want
          <Explain term="agent" technical className="size-6 [&_svg]:size-5" />
        </span>
      </StepTitle>
      <StepLead>
        An agent is {plainExplanation("agent").replace(/\.$/u, "").toLowerCase()}. Uno, OpenCode and
        Hermes come with your machine, already signed in through the Uno gateway. Claude Code, Codex
        and Cursor run on your own subscriptions — install them here with one click, then sign in.
      </StepLead>

      <div className="mt-8 max-w-xl">
        <HarnessSetupList providers={providers} />
      </div>

      <p className="mt-4 max-w-xl text-xs text-muted-foreground">
        Installs run on your machine as your own user — no terminal needed. Once an agent is ready
        it shows up in the model picker automatically; no restart.
      </p>
    </div>
  );
}
