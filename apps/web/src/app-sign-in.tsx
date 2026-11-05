import { Button, ErrorText } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "./api";
import { Welcome } from "./sign-in";

const pendingKey = "pipoca.app-sign-in";

// The desktop app opens #app/<challenge> in the browser (ADR 0055). Signing
// in first, with a password or single sign-on, leaves the page, so the tab
// keeps the challenge until the person answers.
export function pendingAppSignIn(): string | undefined {
  const challenge = /^#app\/([\w-]{43})$/.exec(location.hash)?.[1];

  try {
    if (challenge !== undefined) {
      sessionStorage.setItem(pendingKey, challenge);
    }

    return challenge ?? sessionStorage.getItem(pendingKey) ?? undefined;
  } catch {
    return challenge;
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(pendingKey);
  } catch {
    // Nothing kept.
  }
}

// Asks before handing the app a sign-in, so a page that opens this link
// can't sign someone else's app in as this person.
export function AppSignIn({
  challenge,
  user,
}: {
  readonly challenge: string;
  readonly user: string;
}): ReactElement {
  const [state, setState] = useState<"asking" | "opened">("asking");
  const [error, setError] = useState<string>();

  const open = (): void => {
    void (async () => {
      try {
        const { link } = await api("auth.appLinks.create", {
          body: { challenge },
        });

        forget();
        setState("opened");
        location.assign(link);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "");
      }
    })();
  };

  const cancel = (): void => {
    forget();
    location.replace("/");
  };

  if (state === "opened") {
    return (
      <Welcome
        title="Pipoca is open"
        description="The app is signed in. You can close this tab."
      />
    );
  }

  return (
    <Welcome
      title="Sign in to the Pipoca app"
      description={`The app on this computer asked to sign in as ${user}.`}
    >
      <div className="flex flex-col gap-2">
        <ErrorText size="caption">{error}</ErrorText>
        <Button variant="primary" className="h-10 w-full" onClick={open}>
          Open Pipoca
        </Button>
        <Button className="h-10 w-full" onClick={cancel}>
          Not now
        </Button>
      </div>
    </Welcome>
  );
}
