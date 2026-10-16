/**
 * The password field of a share link, with Generate (a readable random
 * password, shown in clear), Copy, and "Copy link and password" — shown once
 * the link exists. Used by Files → Share and the panel's ↗ share popover.
 * Without `onPasswordChange` it only shows a password already set on a link.
 */
import { CheckIcon, CopyIcon, DicesIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatLinkAndPassword, generateReadablePassword } from "../../lib/readablePassword";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

function copyFailed(_error: Error, text: string) {
  toastManager.add({ type: "error", title: "Couldn't copy", description: text });
}

export function PasswordGenerateControls({
  password,
  onPasswordChange,
  link,
  size = "default",
  placeholder = "At least 4 characters",
}: {
  password: string;
  /** Leave out to show a password that's already on a link (read-only, no Generate). */
  onPasswordChange?: (password: string) => void;
  /** The link the password opens; null until it's created. */
  link: string | null;
  size?: "sm" | "default";
  placeholder?: string;
}) {
  const copyPassword = useCopyToClipboard<string>({ timeout: 1500, onError: copyFailed });
  const copyBoth = useCopyToClipboard<string>({ timeout: 1500, onError: copyFailed });
  const small = size === "sm";
  const editable = onPasswordChange !== undefined;
  const bothText = link && password ? formatLinkAndPassword(link, password) : null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="share-password-controls">
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          size={small ? "sm" : "default"}
          value={password}
          readOnly={!editable}
          onChange={editable ? (event) => onPasswordChange(event.target.value) : undefined}
          onFocus={editable ? undefined : (event) => event.currentTarget.select()}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-label="Link password"
          className="font-mono"
        />
        {editable ? (
          <Button
            type="button"
            size={small ? "xs" : "sm"}
            variant="outline"
            onClick={() => onPasswordChange(generateReadablePassword())}
            data-testid="share-password-generate"
          >
            <DicesIcon />
            Generate
          </Button>
        ) : null}
        <Button
          type="button"
          size={small ? "icon-xs" : "icon-sm"}
          variant="outline"
          aria-label="Copy password"
          title="Copy password"
          disabled={!password}
          onClick={() => copyPassword.copyToClipboard(password, password)}
        >
          {copyPassword.isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      {/* Only once the link exists (Misha 16.10: a greyed-out button before it confused). */}
      {bothText ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() => copyBoth.copyToClipboard(bothText, bothText)}
          data-testid="share-copy-link-and-password"
        >
          {copyBoth.isCopied ? <CheckIcon /> : <CopyIcon />}
          {copyBoth.isCopied ? "Copied" : "Copy link and password"}
        </Button>
      ) : null}
    </div>
  );
}
