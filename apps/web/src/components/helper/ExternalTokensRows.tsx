import { useCallback, useEffect, useState } from "react";
import type {
  EnvironmentId,
  ManagerCapabilityTokenDescriptor,
  ManagerTokenId,
} from "@t3tools/contracts";
import { isAssistantProjectId } from "@t3tools/contracts";

import { listManagerTokens, revokeManagerToken } from "../../lib/managerApi";
import { SettingsRow } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export const isAssistantOwnedToken = (token: ManagerCapabilityTokenDescriptor): boolean =>
  token.label.startsWith("assistant:") ||
  token.label === "assistant-inapp" ||
  isAssistantProjectId(token.label.replace(/^assistant:/, ""));

/**
 * Capability tokens for EXTERNAL brains (e.g. a Hermes sidecar over MCP).
 * Assistants manage their own tokens automatically, so those are hidden.
 * Rows in one daemon's database, hence bound to an explicit environment.
 */
export function ExternalTokensRows({
  environmentId,
  canMutate,
  onError,
}: {
  environmentId: EnvironmentId;
  canMutate: boolean;
  onError: (message: string) => void;
}) {
  const [tokens, setTokens] = useState<ReadonlyArray<ManagerCapabilityTokenDescriptor> | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      const result = await listManagerTokens({ environmentId });
      setTokens(result.tokens);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Failed to load assistant tokens.");
    }
  }, [environmentId, onError]);

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

  if (tokens === null) {
    return <SettingsRow title="Loading…" description="" />;
  }
  const externalTokens = tokens.filter(
    (token) => token.revokedAt === null && !isAssistantOwnedToken(token),
  );
  if (externalTokens.length === 0) {
    return (
      <SettingsRow
        title="No external tokens"
        description="Capability tokens let an external agent (e.g. a Hermes sidecar) use the manager tools over MCP at /api/manager/mcp. Assistants manage their own tokens automatically."
      />
    );
  }
  return (
    <>
      {externalTokens.map((token) => (
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
      ))}
    </>
  );
}
