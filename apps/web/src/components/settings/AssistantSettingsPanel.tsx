/**
 * Assistant settings that belong to an *environment* rather than to this app:
 * capability tokens for EXTERNAL brains (e.g. a Hermes sidecar over MCP).
 * Everything about a specific assistant (access, connectors, context files)
 * lives in that assistant's own settings: sidebar → Assistants → gear.
 *
 * Capability tokens are rows in one daemon's database, so this panel is bound
 * to an explicit environment and says which one it is reading.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BotIcon, KeyRoundIcon } from "lucide-react";
import type {
  EnvironmentId,
  ManagerCapabilityTokenDescriptor,
  ManagerTokenId,
} from "@t3tools/contracts";
import { isAssistantProjectId } from "@t3tools/contracts";

import { EnvironmentScopeBanner } from "../../environments/scope/EnvironmentScopeBanner";
import { useEnvironmentScope } from "../../environments/scope/scopes";
import { listManagerTokens, revokeManagerToken } from "../../lib/managerApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const isAssistantOwnedToken = (token: ManagerCapabilityTokenDescriptor): boolean =>
  token.label.startsWith("assistant:") ||
  token.label === "assistant-inapp" ||
  isAssistantProjectId(token.label.replace(/^assistant:/, ""));

export function AssistantSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const scope = useEnvironmentScope(environmentId);
  const canMutate = scope?.availability.canMutate ?? false;
  const [tokens, setTokens] = useState<ReadonlyArray<ManagerCapabilityTokenDescriptor> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listManagerTokens({ environmentId });
      setTokens(result.tokens);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load assistant tokens.");
    }
  }, [environmentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRevoke = useCallback(
    (tokenId: ManagerTokenId) => {
      if (!canMutate) return;
      void revokeManagerToken({ environmentId, tokenId }).finally(() => void refresh());
    },
    [canMutate, environmentId, refresh],
  );

  const externalTokens = (tokens ?? []).filter(
    (token) => token.revokedAt === null && !isAssistantOwnedToken(token),
  );

  return (
    <SettingsPageContainer>
      <EnvironmentScopeBanner scope={scope} environmentId={environmentId} />
      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <SettingsSection title="Assistants" icon={<BotIcon className="size-3.5" />}>
        <SettingsRow
          title="Per-assistant settings moved"
          description="Access, permissions, Telegram bots, instructions and skills are configured per assistant."
          control={
            <Button size="xs" variant="outline" render={<Link to="/assistant" />}>
              Open assistants
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="External brains (advanced)"
        icon={<KeyRoundIcon className="size-3.5" />}
      >
        {tokens === null ? (
          <SettingsRow title="Loading…" description="" />
        ) : externalTokens.length === 0 ? (
          <SettingsRow
            title="No external tokens"
            description="Capability tokens let an external agent (e.g. a Hermes sidecar) use the manager tools over MCP at /api/manager/mcp. Assistants manage their own tokens automatically."
          />
        ) : (
          externalTokens.map((token) => (
            <SettingsRow
              key={token.tokenId}
              title={token.label}
              description={`created ${new Date(token.createdAt).toLocaleString()}`}
              status={
                <span className="flex gap-1">
                  {token.scopes.map((scope) => (
                    <Badge key={scope} variant="outline">
                      {scope}
                    </Badge>
                  ))}
                </span>
              }
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={!canMutate}
                  onClick={() => handleRevoke(token.tokenId)}
                >
                  Revoke
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
